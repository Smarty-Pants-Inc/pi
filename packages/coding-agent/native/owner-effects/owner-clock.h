/* Read-only original-addon witness. No host, owner, allocation or permission.
 * Called on the original JS/main thread. Exact ns, not allocation milliseconds.
 * Platform/rate/suspend qualification remains outside this DATA producer. */
static int clock_read_text(const char *path, char *out, size_t capacity) {
	int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	size_t used = 0;
	int error = 0;
	while (used < capacity - 1) {
		ssize_t n = read(fd, out + used, capacity - 1 - used);
		if (n < 0 && errno == EINTR) continue;
		if (n < 0) { error = errno; break; }
		if (!n) break;
		used += (size_t)n;
	}
	if (used == capacity - 1) error = EOVERFLOW;
	if (close(fd) < 0 && !error) error = errno;
	if (error) { errno = error; return -1; }
	if (used && out[used - 1] == '\n') used--;
	out[used] = 0;
	if (!used) { errno = EIO; return -1; }
	return 0;
}

static napi_value read_clock_sample(napi_env env, napi_callback_info info) {
	static _Atomic int failed = 0;
	static char original_source[128] = {0};
	napi_value result, value, space;
	size_t argc = 1;
	napi_value argument;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &argument, NULL, NULL));
	if (failed) return failure(env, "OWNER_CLOCK_SAMPLE", failed);
	if (argc || syscall(SYS_gettid) != getpid()) {
		failed = EPERM;
		return failure(env, "OWNER_CLOCK_SAMPLE", failed);
	}
	char boot[40], boot_after[40], source[128], source_after[128];
	struct stat before, after;
	struct timespec now;
	int fd = open("/proc/self/ns/time", O_RDONLY | O_CLOEXEC);
	if (fd < 0) { failed = errno; return failure(env, "OWNER_CLOCK_SAMPLE", failed); }
	int error = 0;
	if (fstat(fd, &before) < 0 ||
		clock_read_text("/proc/sys/kernel/random/boot_id", boot, sizeof(boot)) < 0 ||
		clock_read_text("/sys/devices/system/clocksource/clocksource0/current_clocksource", source, sizeof(source)) < 0 ||
		clock_gettime(CLOCK_MONOTONIC, &now) < 0 ||
		clock_read_text("/proc/sys/kernel/random/boot_id", boot_after, sizeof(boot_after)) < 0 ||
		clock_read_text("/sys/devices/system/clocksource/clocksource0/current_clocksource", source_after, sizeof(source_after)) < 0 ||
		stat("/proc/self/ns/time", &after) < 0) error = errno;
	if (close(fd) < 0 && !error) error = errno;
	if (!error && (before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
		strcmp(boot, boot_after) || strcmp(source, source_after) || now.tv_sec < 0 ||
		now.tv_nsec < 0 || now.tv_nsec >= 1000000000L ||
		(uint64_t)now.tv_sec > (UINT64_MAX - (uint64_t)now.tv_nsec) / 1000000000ULL)) error = ESTALE;
	if (!error && original_source[0] && strcmp(original_source, source)) error = ESTALE;
	if (error) { failed = error; return failure(env, "OWNER_CLOCK_SAMPLE", failed); }
	if (!original_source[0]) memcpy(original_source, source, strlen(source) + 1);
	/* startTicks is retained independently by the original preexec/controller
	 * receiver. This in-process adapter cannot survive a PID incarnation change. */
	char ns[32], device[32], inode[32];
	snprintf(ns, sizeof(ns), "%llu", (unsigned long long)((uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec));
	snprintf(device, sizeof(device), "%llu", (unsigned long long)before.st_dev);
	snprintf(inode, sizeof(inode), "%llu", (unsigned long long)before.st_ino);
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_create_object(env, &space));
	const char *names[] = {"monotonicNs", "bootId"};
	const char *values[] = {ns, boot};
	for (unsigned i = 0; i < 2; i++) {
		NAPI_CALL(env, napi_create_string_utf8(env, values[i], NAPI_AUTO_LENGTH, &value));
		NAPI_CALL(env, napi_set_named_property(env, result, names[i], value));
	}
	NAPI_CALL(env, napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &value));
	NAPI_CALL(env, napi_set_named_property(env, space, "device", value));
	NAPI_CALL(env, napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &value));
	NAPI_CALL(env, napi_set_named_property(env, space, "inode", value));
	NAPI_CALL(env, napi_set_named_property(env, result, "timeNamespace", space));
	NAPI_CALL(env, napi_create_int32(env, (int32_t)getpid(), &value));
	NAPI_CALL(env, napi_set_named_property(env, result, "pid", value));
	if (failed) return failure(env, "OWNER_CLOCK_SAMPLE", failed);
	return result;
}
