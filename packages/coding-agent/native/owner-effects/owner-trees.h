#ifndef PI_OWNER_TREES_H
#define PI_OWNER_TREES_H

/* Bounded native backing for the existing FileDefinitions IO port. All paths
 * are relative to the root on the original read/write Operation. */
typedef struct TreeFile {
	struct TreeFile *next;
	char *path;
	unsigned mode;
	unsigned char *bytes;
	size_t length;
} TreeFile;

typedef struct {
	TreeFile *files;
	unsigned entries, max_files, max_depth;
	size_t bytes, max_bytes;
} TreeCapture;

static void tree_free(TreeFile *file) {
	while (file) {
		TreeFile *next = file->next;
		free(file->path); free(file->bytes); free(file);
		file = next;
	}
}

static bool tree_name(const char *name) {
	if (!file_relative(name) || strchr(name, '/') || strchr(name, '\\')) return false;
	/* Reject noncanonical UTF-8 rather than let N-API replace path bytes. */
	const unsigned char *p = (const unsigned char *)name;
	while (*p) {
		unsigned value = *p++, remaining, minimum;
		if (value < 128) continue;
		if (value >= 0xc2 && value <= 0xdf) { remaining = 1; minimum = 0x80; value &= 0x1f; }
		else if (value >= 0xe0 && value <= 0xef) { remaining = 2; minimum = 0x800; value &= 0x0f; }
		else if (value >= 0xf0 && value <= 0xf4) { remaining = 3; minimum = 0x10000; value &= 7; }
		else return false;
		while (remaining--) {
			if ((*p & 0xc0) != 0x80) return false;
			value = (value << 6) | (*p++ & 0x3f);
		}
		if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
	}
	return true;
}

static int tree_open(Operation *operation, const char *path) {
	return path[0] ? file_open(operation->host->roots[operation->root].fd, path, O_RDONLY | O_DIRECTORY)
		: openat(operation->host->roots[operation->root].fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
}

static bool tree_same(const struct stat *a, const struct stat *b) {
	return S_ISDIR(b->st_mode) && a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
		a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
		a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

static int tree_named(Operation *operation, const char *path, int held) {
	int named = tree_open(operation, path);
	if (named < 0) return -1;
	struct stat a, b;
	int error = fstat(held, &a) < 0 || fstat(named, &b) < 0 ? errno : 0;
	if (!error && !tree_same(&a, &b)) error = ESTALE;
	if (close(named) < 0 && !error) error = errno;
	if (error) { errno = error; return -1; }
	return 0;
}

static int tree_capture(Operation *operation, int fd, const char *prefix, unsigned depth, TreeCapture *capture) {
	if (depth > capture->max_depth) { errno = EOVERFLOW; return -1; }
	struct stat before, after;
	if (fstat(fd, &before) < 0) return -1;
	int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (copy < 0) return -1;
	DIR *directory = fdopendir(copy);
	if (!directory) { close(copy); return -1; }
	int error = 0;
	for (;;) {
		errno = 0;
		struct dirent *entry = readdir(directory);
		if (!entry) { error = errno; break; }
		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
		if (!operation_allowed(operation)) { error = ESTALE; break; }
		if (++capture->entries > capture->max_files || !tree_name(entry->d_name)) { error = EOVERFLOW; break; }
		char path[PATH_MAX];
		int length = snprintf(path, sizeof(path), "%s%s%s", prefix, prefix[0] ? "/" : "", entry->d_name);
		if (length < 0 || (size_t)length >= sizeof(path)) { error = ENAMETOOLONG; break; }
		struct stat named, held;
		if (fstatat(fd, entry->d_name, &named, AT_SYMLINK_NOFOLLOW) < 0) { error = errno; break; }
		int child = file_open(fd, entry->d_name, O_RDONLY | O_NONBLOCK | (S_ISDIR(named.st_mode) ? O_DIRECTORY : 0));
		if (child < 0) { error = errno; break; }
		if (fstat(child, &held) < 0) error = errno;
		else if (named.st_dev != held.st_dev || named.st_ino != held.st_ino) error = ESTALE;
		else if (S_ISDIR(held.st_mode)) {
			if (tree_capture(operation, child, path, depth + 1, capture) < 0) error = errno;
		} else {
			TreeFile *file = calloc(1, sizeof(*file));
			if (!file) error = ENOMEM;
			else {
				file->path = strdup(path);
				file->mode = held.st_mode & 0777;
				if (!file->path || file_read_bytes(child, capture->max_bytes - capture->bytes, &file->bytes, &file->length, &held) < 0) error = errno;
				if (!error && (fstatat(fd, entry->d_name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !file_same(&held, &named))) error = ESTALE;
				if (error) tree_free(file);
				else { capture->bytes += file->length; file->next = capture->files; capture->files = file; }
			}
		}
		if (close(child) < 0 && !error) error = errno;
		if (error) break;
	}
	if (closedir(directory) < 0 && !error) error = errno;
	if (!error && fstat(fd, &after) < 0) error = errno;
	if (!error && !tree_same(&before, &after)) error = ESTALE;
	if (error) { errno = error; return -1; }
	return 0;
}

static napi_value read_tree(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value args[3], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char path[PATH_MAX];
	uint32_t max_files, max_bytes, max_depth;
	if (argc != 3 || !get_string(env, args[1], path, sizeof(path)) || (path[0] && !file_relative(path)) ||
		!get_u32(env, args[2], "maxFiles", &max_files) || !max_files || max_files > 256 ||
		!get_u32(env, args[2], "maxBytes", &max_bytes) || !max_bytes ||
		!get_u32(env, args[2], "maxDepth", &max_depth) || max_depth > 16) return failure(env, "OWNER_TREE_LIMIT", EINVAL);
	Operation *operation = file_operation(env, args[0], false);
	if (!operation) return failure(env, "OWNER_FILE_OPERATION", ESTALE);
	TreeCapture capture = {.max_files = max_files, .max_bytes = max_bytes, .max_depth = max_depth};
	int fd = -1, error = max_bytes > operation->host->output_limit ? EFBIG : 0;
	if (!error) { fd = tree_open(operation, path); if (fd < 0) error = errno; }
	if (!error && tree_capture(operation, fd, "", 0, &capture) < 0) error = errno;
	if (!error && (!operation_allowed(operation) || tree_named(operation, path, fd) < 0)) error = ESTALE;
	if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	pthread_mutex_unlock(&operation->host->gate);
	if (error) { tree_free(capture.files); return failure(env, "OWNER_TREE_READ", error); }
	napi_status status = napi_create_array(env, &result);
	unsigned index = 0;
	for (TreeFile *file = capture.files; file && status == napi_ok; file = file->next) {
		napi_value row, name, mode, bytes;
		status = napi_create_object(env, &row);
		if (status == napi_ok) status = napi_create_string_utf8(env, file->path, NAPI_AUTO_LENGTH, &name);
		if (status == napi_ok) status = napi_create_uint32(env, file->mode, &mode);
		if (status == napi_ok) status = napi_create_buffer_copy(env, file->length, file->bytes, NULL, &bytes);
		if (status == napi_ok) status = napi_set_named_property(env, row, "path", name);
		if (status == napi_ok) status = napi_set_named_property(env, row, "mode", mode);
		if (status == napi_ok) status = napi_set_named_property(env, row, "bytes", bytes);
		if (status == napi_ok) status = napi_set_element(env, result, index++, row);
	}
	tree_free(capture.files);
	NAPI_CALL(env, status);
	return result;
}

static napi_value list_directories(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char path[PATH_MAX];
	if (argc != 2 || !get_string(env, args[1], path, sizeof(path)) || (path[0] && !file_relative(path))) return failure(env, "OWNER_FILE_PATH", EINVAL);
	Operation *operation = file_operation(env, args[0], false);
	if (!operation) return failure(env, "OWNER_FILE_OPERATION", ESTALE);
	int fd = tree_open(operation, path);
	int error = fd < 0 && errno != ENOENT ? errno : 0;
	DIR *directory = fd < 0 ? NULL : fdopendir(fd);
	if (fd >= 0 && !directory) { error = errno; close(fd); }
	char *names[256] = {0};
	unsigned count = 0, entries = 0;
	struct stat before, after;
	if (!error && directory && fstat(fd, &before) < 0) error = errno;
	while (!error && directory) {
		errno = 0;
		struct dirent *entry = readdir(directory);
		if (!entry) { error = errno; break; }
		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
		if (!operation_allowed(operation)) { error = ESTALE; break; }
		if (++entries > 256 || !tree_name(entry->d_name)) { error = EOVERFLOW; break; }
		struct stat info;
		if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) < 0) { error = errno; break; }
		if (S_ISLNK(info.st_mode)) { error = ELOOP; break; }
		if (!S_ISDIR(info.st_mode)) continue;
		int child = file_open(fd, entry->d_name, O_RDONLY | O_DIRECTORY);
		if (child < 0) { error = errno; break; }
		if (fstat(child, &after) < 0 || !tree_same(&info, &after)) error = ESTALE;
		if (close(child) < 0 && !error) error = errno;
		if (error) break;
		names[count] = strdup(entry->d_name);
		if (!names[count]) { error = ENOMEM; break; }
		count++;
	}
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (!error && directory && (fstat(fd, &after) < 0 || !tree_same(&before, &after) || tree_named(operation, path, fd) < 0)) error = ESTALE;
	if (directory && closedir(directory) < 0 && !error) error = errno;
	pthread_mutex_unlock(&operation->host->gate);
	napi_status status = error ? napi_ok : napi_create_array_with_length(env, count, &result);
	for (unsigned i = 0; i < count; i++) {
		napi_value name;
		if (!error && status == napi_ok) status = napi_create_string_utf8(env, names[i], NAPI_AUTO_LENGTH, &name);
		if (!error && status == napi_ok) status = napi_set_element(env, result, i, name);
		free(names[i]);
	}
	if (error) return failure(env, "OWNER_TREE_LIST", error);
	NAPI_CALL(env, status);
	return result;
}

/* Cleanup never follows symlinks or crosses a mount. Failure remains unknown
 * even if the JavaScript caller catches the exception. */
static int tree_remove(Operation *operation, int parent, const char *name, unsigned *remaining, unsigned depth) {
	if (!operation_allowed(operation)) { errno = ESTALE; return -1; }
	if (!*remaining || depth > 16) { errno = EOVERFLOW; return -1; }
	--*remaining;
	int fd = file_open(parent, name, O_RDONLY | O_DIRECTORY);
	if (fd < 0) return -1;
	struct stat held, named;
	int error = fstat(fd, &held) < 0 ? errno : 0;
	if (!error && (held.st_uid != getuid() || (held.st_mode & 0077))) error = EPERM;
	DIR *directory = error ? NULL : fdopendir(fd);
	if (!directory) { if (!error) error = errno; close(fd); }
	while (!error) {
		errno = 0;
		struct dirent *entry = readdir(directory);
		if (!entry) { error = errno; break; }
		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
		if (!operation_allowed(operation)) { error = ESTALE; break; }
		if (!tree_name(entry->d_name) || !*remaining) { error = EOVERFLOW; break; }
		struct stat info;
		if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) < 0) { error = errno; break; }
		if (S_ISDIR(info.st_mode)) {
			if (tree_remove(operation, fd, entry->d_name, remaining, depth + 1) < 0) error = errno;
		} else if (!S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != getuid()) error = EPERM;
		else { --*remaining; if (unlinkat(fd, entry->d_name, 0) < 0) error = errno; }
	}
	if (!error && fsync(fd) < 0) error = errno;
	if (!error && (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || named.st_dev != held.st_dev || named.st_ino != held.st_ino)) error = ESTALE;
	if (directory && closedir(directory) < 0 && !error) error = errno;
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (!error && (unlinkat(parent, name, AT_REMOVEDIR) < 0 || fsync(parent) < 0)) error = errno;
	if (error) { errno = error; return -1; }
	return 0;
}

static napi_value remove_snapshot(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char path[PATH_MAX], leaf[NAME_MAX + 1];
	if (argc != 2 || !get_string(env, args[1], path, sizeof(path)) || !file_relative(path)) return failure(env, "OWNER_FILE_PATH", EINVAL);
	Operation *operation = file_operation(env, args[0], true);
	if (!operation) return failure(env, "OWNER_FILE_OPERATION", ESTALE);
	int parent = file_parent(operation, path, false, leaf);
	int error = parent < 0 ? errno : 0;
	unsigned remaining = 1024;
	if (!error && tree_remove(operation, parent, leaf, &remaining, 0) < 0) error = errno;
	if (parent >= 0 && close(parent) < 0 && !error) error = errno;
	if (error) file_uncertain(operation);
	pthread_mutex_unlock(&operation->host->gate);
	if (error) return failure(env, "OWNER_SNAPSHOT_REMOVE", error);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value create_snapshot(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value args[4], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	char parent_path[PATH_MAX], revision[65];
	uint32_t count;
	if (argc != 4 || !get_string(env, args[1], parent_path, sizeof(parent_path)) || !file_relative(parent_path) ||
		!get_string(env, args[2], revision, sizeof(revision)) || strlen(revision) != 64 ||
		strspn(revision, "0123456789abcdef") != 64 || napi_get_array_length(env, args[3], &count) != napi_ok || count > 256) {
		return failure(env, "OWNER_SNAPSHOT_ARGUMENT", EINVAL);
	}
	TreeFile *files = NULL;
	size_t total = 0;
	int error = 0;
	/* Property access can run JS: copy and validate all input before taking the
	 * gate and rechecking the original operation. */
	for (unsigned i = 0; i < count && !error; i++) {
		napi_value row, value;
		char path[PATH_MAX];
		uint32_t mode;
		void *bytes;
		size_t length;
		if (napi_get_element(env, args[3], i, &row) != napi_ok || !named_string(env, row, "path", path, sizeof(path)) ||
			!file_relative(path) || strchr(path, '\\') || !get_u32(env, row, "mode", &mode) || mode > 0777 ||
			napi_get_named_property(env, row, "bytes", &value) != napi_ok || napi_get_buffer_info(env, value, &bytes, &length) != napi_ok ||
			length > OE_MAX_JOURNAL - total) { error = EINVAL; break; }
		for (TreeFile *other = files; other; other = other->next) if (!strcmp(other->path, path)) error = EINVAL;
		if (error) break;
		TreeFile *file = calloc(1, sizeof(*file));
		if (!file) { error = ENOMEM; break; }
		file->path = strdup(path); file->bytes = malloc(length ? length : 1); file->length = length; file->mode = mode;
		if (!file->path || !file->bytes) { tree_free(file); error = ENOMEM; break; }
		memcpy(file->bytes, bytes, length); total += length;
		file->next = files; files = file;
	}
	if (error) { tree_free(files); return failure(env, "OWNER_SNAPSHOT_ARGUMENT", error); }
	Operation *operation = file_operation(env, args[0], true);
	if (!operation) { tree_free(files); return failure(env, "OWNER_FILE_OPERATION", ESTALE); }
	if (total > operation->host->output_limit) error = EFBIG;
	char path[PATH_MAX], leaf[NAME_MAX + 1];
	unsigned char random[16];
	char suffix[33];
	int parent = -1, snapshot = -1;
	bool created = false;
	if (!error && getrandom(random, sizeof(random), 0) != (ssize_t)sizeof(random)) error = EIO;
	if (!error) {
		for (unsigned i = 0; i < sizeof(random); i++) snprintf(suffix + 2 * i, 3, "%02x", random[i]);
		int length = snprintf(path, sizeof(path), "%s/%s-%s", parent_path, revision, suffix);
		if (length < 0 || (size_t)length >= sizeof(path)) error = ENAMETOOLONG;
	}
	if (!error) { parent = file_parent(operation, path, true, leaf); if (parent < 0) error = errno; }
	if (!error && !operation_allowed(operation)) error = ESTALE;
	if (!error) { if (mkdirat(parent, leaf, 0700) < 0) error = errno; else created = true; }
	if (!error) { snapshot = file_open(parent, leaf, O_RDONLY | O_DIRECTORY); if (snapshot < 0) error = errno; }
	for (TreeFile *file = files; file && !error; file = file->next) {
		char destination[PATH_MAX], name[NAME_MAX + 1];
		int length = snprintf(destination, sizeof(destination), "%s/%s", path, file->path);
		if (length < 0 || (size_t)length >= sizeof(destination)) { error = ENAMETOOLONG; break; }
		int directory = file_parent(operation, destination, true, name);
		if (directory < 0) { error = errno; break; }
		int fd = -1;
		if (!operation_allowed(operation)) error = ESTALE;
		if (!error) { fd = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600); if (fd < 0) error = errno; }
		if (!error && (write_all(fd, file->bytes, file->length) < 0 || fchmod(fd, file->mode) < 0 || fsync(fd) < 0 || fsync(directory) < 0)) error = errno;
		unsigned char *actual = NULL;
		size_t actual_length = 0;
		struct stat held, named;
		if (!error && file_read_bytes(fd, operation->host->output_limit, &actual, &actual_length, &held) < 0) error = errno;
		if (!error && (fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !file_same(&held, &named) ||
			(held.st_mode & 0777) != file->mode || actual_length != file->length || memcmp(actual, file->bytes, file->length))) error = EIO;
		free(actual);
		if (fd >= 0 && close(fd) < 0 && !error) error = errno;
		if (close(directory) < 0 && !error) error = errno;
	}
	if (!error && (fsync(snapshot) < 0 || fsync(parent) < 0)) error = errno;
	if (!error && (!operation_allowed(operation) || tree_named(operation, path, snapshot) < 0)) error = ESTALE;
	if (snapshot >= 0 && close(snapshot) < 0 && !error) error = errno;
	if (error && created) { unsigned remaining = 1024; (void)tree_remove(operation, parent, leaf, &remaining, 0); }
	if (parent >= 0 && close(parent) < 0 && !error) error = errno;
	if (error) file_uncertain(operation);
	pthread_mutex_unlock(&operation->host->gate);
	tree_free(files);
	if (error) return failure(env, "OWNER_SNAPSHOT_CREATE", error);
	napi_status status = napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result);
	if (status != napi_ok) {
		pthread_mutex_lock(&operation->host->gate);
		file_uncertain(operation);
		pthread_mutex_unlock(&operation->host->gate);
	}
	NAPI_CALL(env, status);
	return result;
}

#endif
