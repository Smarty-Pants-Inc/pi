#ifndef PI_OWNER_FILES_H
#define PI_OWNER_FILES_H

/* File consumers use the original Operation and held admitted root. No JS runs
 * between the last admission check and the filesystem syscall. Symlinks and
 * mount crossings are refused rather than resolved outside that root. */
static bool file_relative(const char *path) {
	if (!path[0] || path[0] == '/' || strlen(path) >= PATH_MAX) return false;
	const char *part = path;
	for (const unsigned char *p = (const unsigned char *)path; ; p++) {
		if (*p && (*p < 32 || *p == 127)) return false;
		if (*p && *p != '/') continue;
		size_t length = (const char *)p - part;
		if (!length || length > NAME_MAX || (length == 1 && part[0] == '.') ||
			(length == 2 && part[0] == '.' && part[1] == '.')) return false;
		if (!*p) return true;
		part = (const char *)p + 1;
	}
}

static int file_open(int parent, const char *name, int flags) {
	struct open_how how = {.flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW),
		.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV};
	return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}

static int file_parent(Operation *operation, const char *path, bool create, char leaf[NAME_MAX + 1]) {
	char copy[PATH_MAX];
	memcpy(copy, path, strlen(path) + 1);
	int parent = duplicate_fd(operation->host->roots[operation->root].fd);
	if (parent < 0) return -1;
	char *part = copy;
	unsigned depth = 0;
	for (;;) {
		char *separator = strchr(part, '/');
		if (!separator) { memcpy(leaf, part, strlen(part) + 1); return parent; }
		if (++depth > 64) { close(parent); errno = EOVERFLOW; return -1; }
		*separator = 0;
		int next = file_open(parent, part, O_RDONLY | O_DIRECTORY);
		if (next < 0 && errno == ENOENT && create) {
			if (!operation_allowed(operation)) { close(parent); errno = ESTALE; return -1; }
			if ((mkdirat(parent, part, 0700) < 0 && errno != EEXIST) || fsync(parent) < 0) {
				int error = errno; close(parent); errno = error; return -1;
			}
			next = file_open(parent, part, O_RDONLY | O_DIRECTORY);
		}
		int error = errno;
		if (close(parent) < 0 && next >= 0) { error = errno; close(next); next = -1; }
		if (next < 0) { errno = error; return -1; }
		parent = next;
		part = separator + 1;
	}
}

static bool file_same(const struct stat *a, const struct stat *b) {
	return S_ISREG(b->st_mode) && b->st_nlink == 1 && a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
		a->st_size == b->st_size && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
		a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

static int file_read_bytes(int fd, size_t limit, unsigned char **bytes, size_t *length, struct stat *before) {
	if (fstat(fd, before) < 0) return -1;
	if (!S_ISREG(before->st_mode) || before->st_nlink != 1 || before->st_size < 0 || (uint64_t)before->st_size > limit) {
		errno = EPERM; return -1;
	}
	*length = (size_t)before->st_size;
	*bytes = malloc(*length ? *length : 1);
	if (!*bytes) return -1;
	size_t used = 0;
	int error = 0;
	while (used < *length) {
		ssize_t n = pread(fd, *bytes + used, *length - used, (off_t)used);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) { error = n < 0 ? errno : EIO; break; }
		used += (size_t)n;
	}
	struct stat after;
	if (!error && fstat(fd, &after) < 0) error = errno;
	if (!error && !file_same(before, &after)) error = ESTALE;
	if (error) { free(*bytes); *bytes = NULL; errno = error; return -1; }
	return 0;
}

static Operation *file_operation(napi_env env, napi_value value, bool writable) {
	bool tagged = false;
	void *pointer = NULL;
	if (napi_check_object_type_tag(env, value, &operation_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return NULL;
	Operation *operation = pointer;
	pthread_mutex_lock(&operation->host->gate);
	if (operation->completed || operation->unknown || !operation->dispatched ||
		(operation->kind != OE_EFFECT_WRITE && (writable || operation->kind != OE_EFFECT_READ)) || !operation_allowed(operation)) {
		pthread_mutex_unlock(&operation->host->gate);
		return NULL;
	}
	/* The caller retains the host gate through the final syscall/readback. */
	return operation;
}

static void file_uncertain(Operation *operation) {
	operation->unknown = true;
	quarantine_owner(operation->owner);
	(void)publish_owner_record(operation->host, operation->owner);
}

static napi_value read_file(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char path[PATH_MAX], leaf[NAME_MAX + 1];
	if (argc != 2 || !get_string(env, args[1], path, sizeof(path)) || !file_relative(path)) return failure(env, "OWNER_FILE_PATH", EINVAL);
	Operation *operation = file_operation(env, args[0], false);
	if (!operation) return failure(env, "OWNER_FILE_OPERATION", ESTALE);
	int parent = file_parent(operation, path, false, leaf);
	if (parent < 0) {
		int error = errno;
		pthread_mutex_unlock(&operation->host->gate);
		return failure(env, "OWNER_FILE_PARENT", error);
	}
	int fd = file_open(parent, leaf, O_RDONLY | O_NONBLOCK);
	int error = fd < 0 ? errno : 0;
	unsigned char *bytes = NULL;
	size_t length = 0;
	struct stat before, named;
	if (!error && file_read_bytes(fd, operation->host->output_limit, &bytes, &length, &before) < 0) error = errno;
	if (!error && fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) < 0) error = errno;
	if (!error && (!file_same(&before, &named) || !operation_allowed(operation))) error = ESTALE;
	if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	if (close(parent) < 0 && !error) error = errno;
	pthread_mutex_unlock(&operation->host->gate);
	if (error) { free(bytes); return failure(env, "OWNER_FILE_READ", error); }
	napi_status status = napi_create_buffer_copy(env, length, bytes, NULL, &result);
	free(bytes);
	NAPI_CALL(env, status);
	return result;
}

static napi_value write_file(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value args[4], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char path[PATH_MAX], leaf[NAME_MAX + 1];
	void *bytes, *previous = NULL;
	size_t length, previous_length = 0;
	napi_valuetype previous_type;
	if (argc != 4 || !get_string(env, args[1], path, sizeof(path)) || !file_relative(path) ||
		napi_get_buffer_info(env, args[2], &bytes, &length) != napi_ok || napi_typeof(env, args[3], &previous_type) != napi_ok ||
		(previous_type != napi_undefined && napi_get_buffer_info(env, args[3], &previous, &previous_length) != napi_ok)) {
		return failure(env, "OWNER_FILE_ARGUMENT", EINVAL);
	}
	Operation *operation = file_operation(env, args[0], true);
	if (!operation) return failure(env, "OWNER_FILE_OPERATION", EPERM);
	if (length > operation->host->output_limit || previous_length > operation->host->output_limit) {
		pthread_mutex_unlock(&operation->host->gate);
		return failure(env, "OWNER_FILE_OPERATION", EFBIG);
	}
	int parent = file_parent(operation, path, previous_type == napi_undefined, leaf);
	if (parent < 0) {
		int error = errno;
		/* Parent creation may already have changed the filesystem. A caller
		 * catching this exception cannot turn it into a settled write. */
		file_uncertain(operation);
		pthread_mutex_unlock(&operation->host->gate);
		return failure(env, "OWNER_FILE_PARENT", error);
	}
	struct stat before, named;
	int found = fstatat(parent, leaf, &before, AT_SYMLINK_NOFOLLOW);
	int error = found < 0 && errno != ENOENT ? errno : 0;
	if (!error && found == 0 && (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_uid != getuid() || (before.st_mode & 0077))) error = EPERM;
	if (!error && previous_type != napi_undefined) {
		int fd = file_open(parent, leaf, O_RDONLY | O_NONBLOCK);
		unsigned char *actual = NULL;
		size_t actual_length = 0;
		struct stat observed;
		if (fd < 0) error = errno;
		else if (file_read_bytes(fd, operation->host->output_limit, &actual, &actual_length, &observed) < 0) error = errno;
		else if (!file_same(&before, &observed) || actual_length != previous_length || memcmp(actual, previous, actual_length)) error = ESTALE;
		free(actual);
		if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	}
	char temporary[64] = {0};
	unsigned char random[16];
	int fd = -1;
	if (!error && getrandom(random, sizeof(random), 0) != (ssize_t)sizeof(random)) error = EIO;
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (!error) {
		memcpy(temporary, ".pi-write-", 10);
		for (unsigned i = 0; i < sizeof(random); i++) snprintf(temporary + 10 + 2 * i, 3, "%02x", random[i]);
		fd = openat(parent, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, found == 0 ? before.st_mode & 0700 : 0600);
		if (fd < 0) error = errno;
	}
	if (!error && (write_all(fd, bytes, length) < 0 || fsync(fd) < 0)) error = errno;
	if (!error) {
		int present = fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW);
		if (found == 0 ? (present < 0 || !file_same(&before, &named)) : (present == 0 || errno != ENOENT)) error = ESTALE;
	}
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (!error && renameat(parent, temporary, parent, leaf) < 0) error = errno;
	if (!error && fsync(parent) < 0) error = errno;
	if (!error) {
		unsigned char *actual = NULL;
		size_t actual_length = 0;
		struct stat held;
		if (file_read_bytes(fd, operation->host->output_limit, &actual, &actual_length, &held) < 0) error = errno;
		else if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) < 0) error = errno;
		else if (!file_same(&held, &named) || actual_length != length || memcmp(actual, bytes, length)) error = EIO;
		free(actual);
	}
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	if (error && fd >= 0) (void)unlinkat(parent, temporary, 0);
	if (close(parent) < 0 && !error) error = errno;
	if (error) file_uncertain(operation);
	pthread_mutex_unlock(&operation->host->gate);
	if (error) return failure(env, "OWNER_FILE_WRITE", error);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

#endif
