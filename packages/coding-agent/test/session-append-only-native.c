/* smarty-dev#6719: actual native storage body; fabricated low-level metadata.
 * No Host validation, owner admission, release or grant qualification is claimed.
 * Include the production source, never a rewritten copy of the commit body. */
#include "../native/owner-effects/owner-effects.c"

static uint64_t journal_written, journal_read;
static bool fail_sync, crash_after_write;
ssize_t __real_write(int fd, const void *bytes, size_t length);
ssize_t __real_pread(int fd, void *bytes, size_t length, off_t offset);
ssize_t __real_pread64(int fd, void *bytes, size_t length, off64_t offset);
int __real_fsync(int fd);

static bool journal_fd(int fd) {
	char path[64], name[PATH_MAX];
	snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
	ssize_t size = readlink(path, name, sizeof(name) - 1);
	if (size < 0) return false;
	name[size] = 0;
	const char *base = strrchr(name, '/');
	return base && !strcmp(base + 1, "probe.jsonl");
}
ssize_t __wrap_write(int fd, const void *bytes, size_t length) {
	ssize_t count = __real_write(fd, bytes, length);
	if (count > 0 && journal_fd(fd)) {
		journal_written += (uint64_t)count;
		if (crash_after_write) _exit(73);
	}
	return count;
}
ssize_t __wrap_pread(int fd, void *bytes, size_t length, off_t offset) {
	ssize_t count = __real_pread(fd, bytes, length, offset);
	if (count > 0 && journal_fd(fd)) journal_read += (uint64_t)count;
	return count;
}
ssize_t __wrap_pread64(int fd, void *bytes, size_t length, off64_t offset) {
	ssize_t count = __real_pread64(fd, bytes, length, offset);
	if (count > 0 && journal_fd(fd)) journal_read += (uint64_t)count;
	return count;
}
int __wrap_fsync(int fd) {
	if (fail_sync && journal_fd(fd)) { fail_sync = false; errno = EIO; return -1; }
	return __real_fsync(fd);
}
#define REQUIRE(condition) do { if (!(condition)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #condition, errno); exit(1); } } while (0)

static Host *storage(const char *scratch, unsigned index) {
	Host *host = calloc(1, sizeof(*host));
	REQUIRE(host);
	snprintf(host->storage_path, sizeof(host->storage_path), "%s/case-%u", scratch, index);
	REQUIRE(mkdir(host->storage_path, 0700) == 0);
	host->storage = open(host->storage_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	host->cgroup = open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	REQUIRE(host->storage >= 0 && host->cgroup >= 0);
	host->journal_limit = OE_MAX_JOURNAL;
	host->record_limit = OE_MAX_CONTROL;
	snprintf(host->unit, sizeof(host->unit), "probe.service");
	snprintf(host->cgroup_path, sizeof(host->cgroup_path), "/probe.slice/probe.service");
	memset(host->profile_digest, '0', 64);
	memset(host->invocation, '0', 32);
	REQUIRE(read_small_at(AT_FDCWD, "/proc/sys/kernel/random/boot_id", host->boot, sizeof(host->boot) - 1) > 0);
	host->boot[strcspn(host->boot, "\n")] = 0;
	Owner *owner = &host->owners[0];
	owner->active = true;
	owner->directory = host->storage;
	owner->group = owner->effects = -1;
	owner->holder = &host->holders[0];
	memset(owner->grant, '0', 64);
	snprintf(owner->lock_name, sizeof(owner->lock_name), "probe.lock");
	snprintf(owner->journal_name, sizeof(owner->journal_name), "probe.jsonl");
	snprintf(owner->record_name, sizeof(owner->record_name), "probe.owner");
	snprintf(owner->group_name, sizeof(owner->group_name), "o-00000000000000000000000000000000");
	int lock = openat(host->storage, owner->lock_name, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	REQUIRE(lock >= 0);
	struct stat st;
	REQUIRE(fstat(lock, &st) == 0);
	owner->lock_device = (uint64_t)st.st_dev;
	owner->lock_inode = (uint64_t)st.st_ino;
	REQUIRE(close(lock) == 0);
	return host;
}
static void cleanup(Host *host) {
	free(host->owners[0].record_bytes);
#ifdef APPEND_ONLY_BODY
	free(host->owners[0].journal_bytes);
#endif
	REQUIRE(close(host->storage) == 0);
	REQUIRE(close(host->cgroup) == 0);
	free(host);
}
static int append_bytes(Host *host, unsigned char *image, size_t previous, const unsigned char *suffix, size_t length, bool terminal) {
#ifdef APPEND_ONLY_BODY
	(void)image;
	return append_journal_bytes(host, &host->owners[0], "probe.jsonl", previous, suffix, length, terminal);
#else
	memcpy(image + previous, suffix, length);
	return commit_journal_bytes(host, &host->owners[0], "probe.jsonl", image, previous, image, previous + length, terminal);
#endif
}
static void identical_reopen(Host *host, const unsigned char *expected, size_t length) {
	int fd = openat(host->storage, "probe.jsonl", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
	REQUIRE(fd >= 0);
	struct stat st;
	REQUIRE(fstat(fd, &st) == 0 && (size_t)st.st_size == length);
	unsigned char chunk[32768];
	for (size_t offset = 0; offset < length;) {
		size_t count = length - offset;
		if (count > sizeof(chunk)) count = sizeof(chunk);
		ssize_t read = pread(fd, chunk, count, (off_t)offset);
		REQUIRE(read > 0 && !memcmp(chunk, expected + offset, (size_t)read));
		offset += (size_t)read;
	}
	REQUIRE(close(fd) == 0);
}
static size_t make_seed(unsigned char *image, size_t length) {
	const char *header = "{\"type\":\"session\",\"version\":3,\"id\":\"probe\",\"cwd\":\"/probe\",\"timestamp\":\"2026-10-09T00:00:00.000Z\"}\n";
	const char *entry = "{\"type\":\"custom\",\"id\":\"seed\",\"parentId\":null,\"timestamp\":\"2026-10-09T00:00:00.000Z\",\"customType\":\"seed\",\"data\":\"";
	size_t start = strlen(header) + strlen(entry);
	REQUIRE(length > start + 3);
	memcpy(image, header, strlen(header));
	memcpy(image + strlen(header), entry, strlen(entry));
	memset(image + start, 'x', length - start - 3);
	memcpy(image + length - 3, "\"}\n", 3);
	return length;
}
typedef struct { uint64_t rchar, wchar, read_bytes, write_bytes; } ProbeIO;
static ProbeIO process_io(void) {
	char bytes[1024];
	REQUIRE(read_small_at(AT_FDCWD, "/proc/self/io", bytes, sizeof(bytes) - 1) > 0);
	ProbeIO io = {0};
	char *line = strtok(bytes, "\n");
	unsigned fields = 0;
	while (line) {
		unsigned long long value;
		if (sscanf(line, "rchar: %llu", &value) == 1) { io.rchar = value; fields++; }
		if (sscanf(line, "wchar: %llu", &value) == 1) { io.wchar = value; fields++; }
		if (sscanf(line, "read_bytes: %llu", &value) == 1) { io.read_bytes = value; fields++; }
		if (sscanf(line, "write_bytes: %llu", &value) == 1) { io.write_bytes = value; fields++; }
		line = strtok(NULL, "\n");
	}
	REQUIRE(fields == 4);
	return io;
}
static void growth(const char *scratch, unsigned index, unsigned turns, size_t seed) {
	Host *host = storage(scratch, index);
	Owner *owner = &host->owners[0];
	/* 50MiB is a synthetic low-level stress limit, NOT an admitted profile.
	 * Production OWNER_NATIVE maximum remains 16MiB. */
	if (seed > OE_MAX_JOURNAL) host->journal_limit = 64U * 1024U * 1024U;
	unsigned char *image = malloc(seed + 1024U * 1024U);
	REQUIRE(image);
	size_t used = make_seed(image, seed);
	REQUIRE(append_bytes(host, image, 0, image, used, false) == 0);
	journal_written = journal_read = 0;
	ProbeIO before = {0};
	uint64_t reads_before = 0, writes_before = 0;
	for (unsigned i = 0; i < turns * 2; i++) {
		if (seed > OE_MAX_JOURNAL && i % 2 == 0) {
			if (getenv("PI_APPEND_COLD_READ")) {
				int fd = openat(host->storage, "probe.jsonl", O_RDONLY | O_CLOEXEC);
				REQUIRE(fd >= 0);
				/* Only this own, previously fsynced journal; never global cache drop. */
				REQUIRE(posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED) == 0 && close(fd) == 0);
			}
			before = process_io(); reads_before = journal_read; writes_before = journal_written;
		}
		char suffix[256];
		int length = snprintf(suffix, sizeof(suffix), "{\"type\":\"custom\",\"id\":\"turn-%u\",\"parentId\":null,\"timestamp\":\"2026-10-09T00:00:00.000Z\",\"customType\":\"turn\",\"data\":%u}\n", i, i);
		REQUIRE(length > 0 && (size_t)length < sizeof(suffix));
		REQUIRE(append_bytes(host, image, used, (unsigned char *)suffix, (size_t)length, false) == 0);
		memcpy(image + used, suffix, (size_t)length);
		used += (size_t)length;
		if (seed > OE_MAX_JOURNAL && i % 2 == 1) {
			ProbeIO after = process_io();
			printf("{\"probe\":\"proc-io-per-turn\",\"turn\":%u,\"seedBytes\":%zu,\"read_bytes\":%llu,\"write_bytes\":%llu,\"rchar\":%llu,\"wchar\":%llu,\"journal_pread\":%llu,\"journal_write\":%llu}\n",
				i / 2, seed, (unsigned long long)(after.read_bytes - before.read_bytes),
				(unsigned long long)(after.write_bytes - before.write_bytes), (unsigned long long)(after.rchar - before.rchar),
				(unsigned long long)(after.wchar - before.wchar), (unsigned long long)(journal_read - reads_before),
				(unsigned long long)(journal_written - writes_before));
		}
	}
	REQUIRE(owner->journal_size == used);
	REQUIRE(journal_written == used - seed);
	REQUIRE(journal_read >= seed);
	printf("{\"probe\":\"native-journal-syscall-bytes\",\"turns\":%u,\"seedBytes\":%zu,\"written\":%llu,\"read\":%llu,\"journalBytes\":%zu}\n", turns, seed, (unsigned long long)journal_written, (unsigned long long)journal_read, used);
	identical_reopen(host, image, used);
	free(image);
	cleanup(host);
}
static void safety(const char *scratch, unsigned index, unsigned mode) {
	Host *host = storage(scratch, index);
	Owner *owner = &host->owners[0];
	unsigned char image[4096];
	size_t used = make_seed(image, 512);
	REQUIRE(append_bytes(host, image, 0, image, used, false) == 0);
	const unsigned char suffix[] = "{\"type\":\"custom\",\"id\":\"last\",\"parentId\":null,\"timestamp\":\"2026-10-09T00:00:00.000Z\",\"customType\":\"end\"}\n";
	size_t length = sizeof(suffix) - 1;
	journal_written = 0;
	if (mode == 0) {
		owner->sealed = true;
		REQUIRE(append_bytes(host, image, used, suffix, length, false) == ESTALE);
		REQUIRE(journal_written == 0);
		REQUIRE(append_bytes(host, image, used, suffix, length, true) == 0);
		memcpy(image + used, suffix, length); used += length;
		const unsigned char last[] = "{\"type\":\"custom\",\"id\":\"control\",\"parentId\":\"last\",\"timestamp\":\"2026-10-09T00:00:00.000Z\",\"customType\":\"control\"}\n";
		REQUIRE(append_bytes(host, image, used, last, sizeof(last) - 1, true) == 0);
		memcpy(image + used, last, sizeof(last) - 1); used += sizeof(last) - 1;
		identical_reopen(host, image, used);
#ifdef APPEND_ONLY_BODY
		uint64_t writes = journal_written;
		unsigned sequence = owner->sequence;
		REQUIRE(append_bytes(host, image, used, NULL, 0, true) == 0);
		REQUIRE(journal_written == writes && owner->sequence == sequence);
#endif
	} else if (mode == 1) {
		int fd = openat(host->storage, "probe.jsonl", O_WRONLY | O_CLOEXEC);
		REQUIRE(fd >= 0 && pwrite(fd, "X", 1, 64) == 1 && close(fd) == 0);
		REQUIRE(append_bytes(host, image, used, suffix, length, false) == ESTALE);
		REQUIRE(owner->uncertain && owner->sealed && journal_written == 0 && owner->journal_size == used);
	} else if (mode == 2) {
		fail_sync = true;
		REQUIRE(append_bytes(host, image, used, suffix, length, false) == EIO);
		REQUIRE(owner->uncertain && owner->sealed && owner->journal_size == used);
		OwnerRecord record;
		REQUIRE(read_owner_record(owner, &record) == 0 && record.uncertainty & OE_RECORD_WRITE_PENDING);
		REQUIRE(record.journal_size == used);
		uint64_t written = journal_written;
		REQUIRE(append_bytes(host, image, used, suffix, length, true) == ESTALE && journal_written == written);
	} else if (mode == 3) {
		pid_t child = fork(); REQUIRE(child >= 0);
		if (!child) { crash_after_write = true; (void)append_bytes(host, image, used, suffix, length, false); _exit(74); }
		int status; REQUIRE(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 73);
		OwnerRecord record;
		REQUIRE(read_owner_record(owner, &record) == 0 && record.uncertainty & OE_RECORD_WRITE_PENDING);
		REQUIRE(record.journal_size == used);
		struct stat st;
		REQUIRE(fstatat(host->storage, "probe.jsonl", &st, AT_SYMLINK_NOFOLLOW) == 0 && (size_t)st.st_size == used + length);
		/* Parseable disk growth is not an acknowledged durable receipt. */
		REQUIRE(append_bytes(host, image, used, suffix, length, false) != 0);
		REQUIRE(owner->uncertain && owner->sealed);
	} else {
		memcpy(image + used, suffix, length);
		unsigned char changed[4096]; memcpy(changed, image, used + length); changed[64] ^= 1;
		owner->sealed = true;
		REQUIRE(commit_journal_bytes(host, owner, "probe.jsonl", image, used, changed, used + length, true) == EINVAL);
		REQUIRE(journal_written == 0 && owner->journal_size == used);
		identical_reopen(host, image, used);
	}
	printf("native safety mode %u passed\n", mode);
	cleanup(host);
}
int main(int argc, char **argv) {
	REQUIRE(argc == 2);
	REQUIRE(setvbuf(stdout, NULL, _IOLBF, 0) == 0);
#ifdef APPEND_ONLY_BODY
	printf("native body=append_journal_bytes\n");
#else
	printf("native body=commit_journal_bytes baseline\n");
#endif
	struct statfs filesystem;
	REQUIRE(statfs(argv[1], &filesystem) == 0);
	printf("storage filesystem type=0x%lx cold-read=%s\n", (unsigned long)filesystem.f_type, getenv("PI_APPEND_COLD_READ") ? "own-journal-fadvise" : "pagecache");
	if (getenv("PI_APPEND_IO_ONLY")) {
		printf("measurement-only: 50MiB /proc stress\n");
		growth(argv[1], 0, 10, 50U * 1024U * 1024U);
		return 0;
	}
	growth(argv[1], 0, 100, 512);
	growth(argv[1], 1, 1000, 512);
	growth(argv[1], 2, 100, 10U * 1024U * 1024U);
	growth(argv[1], 3, 1000, 10U * 1024U * 1024U);
	growth(argv[1], 4, 10, 50U * 1024U * 1024U);
	for (unsigned mode = 0; mode < 5; mode++) safety(argv[1], mode + 5, mode);
	return 0;
}
