/* Capacity belongs to original custody, not a caller-supplied next image. */
static int reserve_journal_bytes(Host *host, Owner *owner, size_t bytes) {
	if (bytes > host->journal_limit) return EOVERFLOW;
	if (bytes <= owner->journal_capacity) return 0;
	size_t capacity = owner->journal_capacity ? owner->journal_capacity : 4096;
	if (capacity > host->journal_limit) capacity = host->journal_limit;
	while (capacity < bytes) {
		capacity = capacity > host->journal_limit / 2 ? host->journal_limit : capacity * 2;
	}
	unsigned char *retained = realloc(owner->journal_bytes, capacity);
	if (!retained) return ENOMEM;
	owner->journal_bytes = retained; owner->journal_capacity = capacity;
	return 0;
}

static bool journal_stat_matches(const struct stat *st, const struct stat *original, size_t bytes) {
	return S_ISREG(st->st_mode) && st->st_nlink == 1 && st->st_uid == getuid() &&
		!(st->st_mode & 0077) && st->st_size == (off_t)bytes &&
		st->st_dev == original->st_dev && st->st_ino == original->st_ino &&
		st->st_mode == original->st_mode && st->st_gid == original->st_gid;
}

/* Bounded scratch still compares EVERY disk byte with original custody. Never
 * replace this with inode/size metadata, a cached hash, or a caller's prefix. */
static int verify_journal_bytes(Owner *owner, int fd, size_t previous_bytes,
	const unsigned char *suffix, size_t suffix_bytes) {
	unsigned char scratch[16384];
	size_t total = previous_bytes + suffix_bytes, used = 0;
	while (used < total) {
		int boundary = lifecycle_journal_boundary(owner);
		if (boundary) return boundary;
		size_t count = total - used;
		if (count > sizeof(scratch)) count = sizeof(scratch);
		ssize_t n = pread(fd, scratch, count, (off_t)used);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) return n < 0 ? errno : EIO;
		size_t prefix = used < previous_bytes ? previous_bytes - used : 0;
		if (prefix > (size_t)n) prefix = (size_t)n;
		if (prefix && memcmp(scratch, owner->journal_bytes + used, prefix)) return ESTALE;
		if ((size_t)n > prefix && memcmp(scratch + prefix,
			suffix + (used + prefix - previous_bytes), (size_t)n - prefix)) return ESTALE;
		used += (size_t)n;
	}
	return lifecycle_journal_boundary(owner);
}

/* Shared journal body: caller owns exclusive original-owner serialization.
 * Empty suffix verifies custody only, without creating/writing/fsyncing files
 * or mutating the owner record. No N-API, mutex or JSON encoding occurs here. */
static int append_journal_bytes(Host *host, Owner *owner, const char *name,
	size_t previous_bytes, const unsigned char *suffix, size_t suffix_bytes, bool terminal_mode) {
	if (previous_bytes > host->journal_limit || suffix_bytes > host->journal_limit - previous_bytes ||
		(suffix_bytes && !suffix)) return EINVAL;
	if ((owner->sealed && !terminal_mode) || owner->uncertain || host->failed || owner->release_started ||
		(terminal_mode && (!owner->sealed || owner->launch_count || owner->operations))) return ESTALE;
	if (strcmp(name, owner->journal_name) || previous_bytes != owner->journal_size ||
		(previous_bytes && (!owner->journal_bytes || previous_bytes > owner->journal_capacity))) return ESTALE;
	if (!owner_lock_matches(host, owner)) {
		owner->uncertain = owner->sealed = true;
		return ESTALE;
	}
	int error = lifecycle_journal_boundary(owner);
	if (error) return error;
	if (!suffix_bytes && owner->record_bytes) {
		OwnerRecord record;
		if (read_owner_record(owner, &record) < 0 || owner->record_length != sizeof(record) ||
			memcmp(&record, owner->record_bytes, sizeof(record))) {
			owner->uncertain = owner->sealed = true;
			return ESTALE;
		}
	}
	size_t next_bytes = previous_bytes + suffix_bytes;
	if (suffix_bytes && (error = reserve_journal_bytes(host, owner, next_bytes))) return error;
	bool pending = false;
	if (suffix_bytes) {
		owner->mutation_flags |= OE_RECORD_WRITE_PENDING;
		pending = true;
		if (publish_owner_record(host, owner) < 0) error = errno;
		if (!error) error = lifecycle_journal_boundary(owner);
	}
	int flags = (suffix_bytes ? O_RDWR : O_RDONLY) | O_CLOEXEC | O_NOFOLLOW;
	if (!previous_bytes && suffix_bytes) flags |= O_CREAT | O_EXCL;
	int fd = error ? -1 : openat(owner->directory, name, flags, 0600);
	if (!error && fd < 0) {
		if (!suffix_bytes && !previous_bytes && errno == ENOENT) return 0;
		error = errno;
	}
	struct stat st = {0}, named, verified;
	if (!error && (fstat(fd, &st) < 0 || fstatat(owner->directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
	if (!error && ((!suffix_bytes && !previous_bytes) || !journal_stat_matches(&st, &st, previous_bytes) ||
		!journal_stat_matches(&named, &st, previous_bytes) ||
		(previous_bytes && ((uint64_t)st.st_dev != owner->journal_device || (uint64_t)st.st_ino != owner->journal_inode)))) error = ESTALE;
	if (!error) error = verify_journal_bytes(owner, fd, previous_bytes, NULL, 0);
	if (!error && (fstat(fd, &verified) < 0 || fstatat(owner->directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
	if (!error && (!journal_stat_matches(&verified, &st, previous_bytes) ||
		!journal_stat_matches(&named, &st, previous_bytes) ||
		verified.st_mtim.tv_sec != st.st_mtim.tv_sec || verified.st_mtim.tv_nsec != st.st_mtim.tv_nsec ||
		verified.st_ctim.tv_sec != st.st_ctim.tv_sec || verified.st_ctim.tv_nsec != st.st_ctim.tv_nsec)) error = ESTALE;
	if (!error && suffix_bytes && lseek(fd, (off_t)previous_bytes, SEEK_SET) < 0) error = errno;
	size_t written = 0;
	while (!error && written < suffix_bytes) {
		if ((error = lifecycle_journal_boundary(owner))) break;
		size_t count = suffix_bytes - written;
		if (count > 16384) count = 16384;
		ssize_t n = write(fd, suffix + written, count);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) { error = n < 0 ? errno : EIO; break; }
		written += (size_t)n;
	}
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && suffix_bytes && fsync(fd) < 0) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && suffix_bytes && fsync(owner->directory) < 0) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	struct stat readback = st;
	if (!error && suffix_bytes && fstat(fd, &readback) < 0) error = errno;
	if (!error && suffix_bytes) error = verify_journal_bytes(owner, fd, previous_bytes, suffix, suffix_bytes);
	if (!error && (fstat(fd, &verified) < 0 || fstatat(owner->directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
	if (!error && (!journal_stat_matches(&readback, &st, next_bytes) ||
		!journal_stat_matches(&verified, &st, next_bytes) || !journal_stat_matches(&named, &st, next_bytes) ||
		verified.st_mtim.tv_sec != readback.st_mtim.tv_sec || verified.st_mtim.tv_nsec != readback.st_mtim.tv_nsec ||
		verified.st_ctim.tv_sec != readback.st_ctim.tv_sec || verified.st_ctim.tv_nsec != readback.st_ctim.tv_nsec)) error = ESTALE;
	if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && suffix_bytes) {
		owner->journal_size = next_bytes;
		owner->journal_device = (uint64_t)st.st_dev; owner->journal_inode = (uint64_t)st.st_ino;
		owner->mutation_flags &= ~OE_RECORD_WRITE_PENDING;
		if (publish_owner_record(host, owner) < 0) error = errno;
		if (!error) error = lifecycle_journal_boundary(owner);
		if (!error) memcpy(owner->journal_bytes + previous_bytes, suffix, suffix_bytes);
	}
	if (error && (pending || error == ESTALE || error == EIO || error == ENOENT)) owner->uncertain = owner->sealed = true;
	return error;
}

/* Full-image compatibility is reserved for initial/import/header callers. It
 * cannot replace the original retained prefix with a caller-supplied image. */
static int commit_journal_bytes(Host *host, Owner *owner, const char *name,
	const unsigned char *previous, size_t previous_bytes, const unsigned char *next, size_t next_bytes,
	bool terminal_mode) {
	if (!next_bytes || next_bytes < previous_bytes || next_bytes > host->journal_limit ||
		(previous_bytes && (!owner->journal_bytes || previous_bytes > owner->journal_capacity ||
		previous_bytes != owner->journal_size || memcmp(previous, owner->journal_bytes, previous_bytes) ||
		memcmp(previous, next, previous_bytes)))) return EINVAL;
	return append_journal_bytes(host, owner, name, previous_bytes, next + previous_bytes,
		next_bytes - previous_bytes, terminal_mode);
}

static napi_value append_journal(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value args[4], result;
	void *mode = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, &mode));
	bool verify = mode == (void *)1;
	bool terminal = mode == (void *)2;
	LeaseRef *reference;
	Owner *owner = argc == (verify ? 3U : 4U) ? get_owner(env, args[0], &reference, verify || terminal) : NULL;
	char name[192];
	double length;
	void *suffix = NULL;
	size_t suffix_bytes = 0;
	if (!owner || !get_string(env, args[1], name, sizeof(name)) || !component(name) ||
		napi_get_value_double(env, args[2], &length) != napi_ok || length != length || length < 0 ||
		length > reference->host->journal_limit || length != (size_t)length ||
		(!verify && napi_get_buffer_info(env, args[3], &suffix, &suffix_bytes) != napi_ok))
		return failure(env, "OWNER_APPEND_ARGUMENT", EINVAL);
	pthread_mutex_lock(&reference->host->gate);
	int error = append_journal_bytes(reference->host, owner, name, (size_t)length, suffix, suffix_bytes,
		terminal || (verify && owner->sealed));
	pthread_mutex_unlock(&reference->host->gate);
	if (error) return failure(env, "OWNER_JOURNAL_UNCERTAIN", error);
	NAPI_CALL(env, napi_create_double(env, length + (double)suffix_bytes, &result));
	return result;
}
