/* Included after owner-admission.h. The trusted H receiver reads the platform
 * copy once; no op/profile resolution and no caller-selected credential path. */
struct OwnerCredential {
	int fds[5];
	struct stat identity[5];
};

static int close_owner_credential(Owner *owner) {
	if (!owner->credential) return 0;
	int error = 0;
	for (unsigned i = 0; i < 5; i++) {
		int fd = owner->credential->fds[i];
		owner->credential->fds[i] = -1;
		/* Linux consumes the descriptor even on a close error. Never retry it. */
		if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	}
	free(owner->credential); owner->credential = NULL;
	return error;
}

static bool credential_identity(const struct stat *a, const struct stat *b, bool file) {
	return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
		a->st_uid == b->st_uid && a->st_gid == b->st_gid && (!file ||
		(a->st_nlink == b->st_nlink && a->st_size == b->st_size &&
		 a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
		 a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec));
}

static int credential_unchanged(Host *host, Owner *owner) {
	OwnerCredential *credential = owner->credential;
	if (!credential) { errno = ESTALE; return -1; }
	const char *names[] = {"/", "run", "credentials", host->unit, "smarty-pi-provider.json"};
	for (unsigned i = 0; i < 5; i++) {
		struct stat held, named;
		if (fstat(credential->fds[i], &held) < 0 ||
			fstatat(i ? credential->fds[i - 1] : AT_FDCWD, names[i], &named, AT_SYMLINK_NOFOLLOW) < 0) return -1;
		if (!credential_identity(&held, &credential->identity[i], i == 4) || !credential_identity(&held, &named, i == 4)) {
			errno = ESTALE; return -1;
		}
	}
	/* Check the held directory AND file mounts; a replacement/bind mount must
	 * not turn held read-only bytes into a writable or externally stored copy. */
	for (unsigned i = 3; i < 5; i++) {
		struct statfs fs;
		struct statvfs mount;
		if (fstatfs(credential->fds[i], &fs) < 0 || fstatvfs(credential->fds[i], &mount) < 0) return -1;
		if ((fs.f_type != TMPFS_MAGIC && fs.f_type != RAMFS_MAGIC) || !(mount.f_flag & ST_RDONLY)) {
			errno = EPERM; return -1;
		}
	}
	return 0;
}

static napi_value receive_credential(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, false) : NULL;
	if (!owner || !owner->admitted || !owner->allocation.id[0]) return failure(env, "OWNER_CREDENTIAL_OWNER", ESTALE);
	Host *host = reference->host;
	if (host->credential_claimed) return failure(env, "OWNER_CREDENTIAL_ALREADY_RECEIVED", EALREADY);
	if (!host->unit[0] || host->unit[0] == '.' ||
		strspn(host->unit, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-") != strlen(host->unit)) {
		return failure(env, "OWNER_CREDENTIAL_UNIT", EINVAL);
	}
	/* Never admit this host's delivery namespace as an observer/tool root. Child
	 * descriptor remapping already closes all unlisted CLOEXEC descriptors. */
	for (unsigned i = 0; i <= host->root_count; i++) {
		const char *path = i == host->root_count ? host->tools_path : host->roots[i].path;
		if (!strcmp(path, "/") || !strcmp(path, "/run") || !strcmp(path, "/run/credentials") ||
			!strncmp(path, "/run/credentials/", 17)) return failure(env, "OWNER_CREDENTIAL_EXPOSED", EPERM);
	}
	/* A failed read/ack also consumes this H delivery. A replacement owner needs
	 * a fresh admitted launch/delivery, not another read of the platform copy. */
	host->credential_claimed = true;
	owner->credential = calloc(1, sizeof(*owner->credential));
	if (!owner->credential) return failure(env, "OWNER_CREDENTIAL_MEMORY", ENOMEM);
	for (unsigned i = 0; i < 5; i++) owner->credential->fds[i] = -1;
	const char *names[] = {"/", "run", "credentials", host->unit, "smarty-pi-provider.json"};
	int error = 0;
	for (unsigned i = 0; i < 5 && !error; i++) {
		int fd = openat(i ? owner->credential->fds[i - 1] : AT_FDCWD, names[i],
			O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (i == 4 ? 0 : O_DIRECTORY));
		owner->credential->fds[i] = fd;
		struct stat *st = &owner->credential->identity[i];
		if (fd < 0 || fstat(fd, st) < 0) error = errno;
		else if (i < 3 && (st->st_uid != 0 || (st->st_mode & 0022))) error = EPERM;
		else if (i >= 3 && ((st->st_uid != 0 && st->st_uid != getuid()) || (st->st_mode & 0027) ||
			((st->st_mode & 0040) && st->st_gid != getgid()))) error = EPERM;
		if (!error && i == 4 && (!S_ISREG(st->st_mode) || st->st_nlink != 1 || (st->st_mode & 0222) ||
			st->st_size <= 0 || st->st_size > 65536)) error = EPERM;
	}
	if (!error && credential_unchanged(host, owner) < 0) error = errno;
	size_t size = error ? 0 : (size_t)owner->credential->identity[4].st_size;
	unsigned char *bytes = size ? malloc(size) : NULL;
	if (!error && !bytes) error = ENOMEM;
	for (size_t used = 0; !error && used < size;) {
		ssize_t count = pread(owner->credential->fds[4], bytes + used, size - used, (off_t)used);
		if (count < 0 && errno == EINTR) continue;
		if (count <= 0) { error = count < 0 ? errno : EIO; break; }
		used += (size_t)count;
	}
	if (!error && (credential_unchanged(host, owner) < 0 || !allocation_current(owner))) error = ESTALE;
	if (!error && napi_create_buffer_copy(env, size, bytes, NULL, &result) != napi_ok) error = ENOMEM;
	if (bytes) { explicit_bzero(bytes, size); free(bytes); }
	if (error) {
		int cleanup = close_owner_credential(owner);
		if (cleanup) quarantine_owner(owner);
		return failure(env, "OWNER_CREDENTIAL_RECEIVING", error);
	}
	return result;
}

static napi_value check_credential(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, false) : NULL;
	if (!owner || !owner->admitted || !owner->credential) return failure(env, "OWNER_CREDENTIAL_OWNER", ESTALE);
	int error = credential_unchanged(reference->host, owner) < 0 ? errno : 0;
	if (!error && !allocation_current(owner)) error = ESTALE;
	if (error) {
		quarantine_owner(owner);
		return failure(env, "OWNER_CREDENTIAL_REPLACED", error);
	}
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}
