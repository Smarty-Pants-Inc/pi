#ifndef PI_OWNER_SANDBOX_H
#define PI_OWNER_SANDBOX_H

#include <elf.h>

static bool sandbox_path(const char *path) {
	if (path[0] != '/' || !path[1] || strstr(path, "//") || strstr(path, "/./") || strstr(path, "/../")) return false;
	size_t length = strlen(path);
	if (path[length - 1] == '/' || !strcmp(path + length - (length >= 2 ? 2 : 1), "/.") ||
		(length >= 3 && !strcmp(path + length - 3, "/.."))) return false;
	for (const unsigned char *p = (const unsigned char *)path; *p; p++) if (*p < 32 || *p == 127 || *p == '@') return false;
	return true;
}

static bool beneath(const char *root, const char *path) {
	size_t n = strlen(root);
	return !strncmp(root, path, n) && (path[n] == 0 || path[n] == '/');
}

static int beneath_open(int directory, const char *relative, int flags) {
	struct open_how how = {.flags = (uint64_t)(flags | O_CLOEXEC),
		.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV};
	return (int)syscall(SYS_openat2, directory, relative[0] ? relative : ".", &how, sizeof(how));
}

/* No host IPC inode, device, cross-mount alias, or writable tool tree. The
 * admitted roots are not mutable by an uncontained adversary. The payload also
 * cannot create sockets/devices/FIFOs or mounts after this scan. */
static int sandbox_tree(int fd, bool immutable, uint64_t mount, unsigned *remaining, unsigned depth) {
	struct stat st;
	if (!*remaining || depth > 64) { errno = EOVERFLOW; return -1; }
	--*remaining;
	if (fstat(fd, &st) < 0 || mount_identity(fd) != mount) { errno = EXDEV; return -1; }
	if ((!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode) && !S_ISLNK(st.st_mode)) ||
		(S_ISREG(st.st_mode) && st.st_nlink != 1) ||
		(immutable && (st.st_uid != 0 || (!S_ISLNK(st.st_mode) && (st.st_mode & (0022 | S_ISUID | S_ISGID)))))) { errno = EPERM; return -1; }
	if (!S_ISDIR(st.st_mode)) return 0;
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
		int child = openat(fd, entry->d_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
		if (child < 0) { error = errno; break; }
		if (sandbox_tree(child, immutable, mount, remaining, depth + 1) < 0) error = errno;
		close(child);
		if (error) break;
	}
	if (closedir(directory) < 0 && !error) error = errno;
	if (error) { errno = error; return -1; }
	return 0;
}

static void close_sandbox(Host *host) {
	for (unsigned i = 0; i < host->root_count; i++) close(host->roots[i].fd);
	for (unsigned i = 0; i < host->artifact_count; i++) close(host->artifacts[i].fd);
	host->root_count = host->artifact_count = 0;
}

static int receive_sandbox(napi_env env, Host *host, napi_value profile, napi_value received) {
	napi_value sandbox, roots, descriptors, artifacts, runtime, closure, files;
	uint32_t roots_count, descriptors_count, closure_count, files_count;
	if (napi_get_named_property(env, profile, "sandbox", &sandbox) != napi_ok ||
		napi_get_named_property(env, sandbox, "fileRoots", &roots) != napi_ok ||
		napi_get_named_property(env, received, "fileRoots", &descriptors) != napi_ok ||
		napi_get_named_property(env, profile, "artifacts", &artifacts) != napi_ok ||
		napi_get_named_property(env, artifacts, "runtime", &runtime) != napi_ok ||
		napi_get_named_property(env, artifacts, "closure", &closure) != napi_ok ||
		napi_get_named_property(env, received, "artifactFiles", &files) != napi_ok ||
		napi_get_array_length(env, roots, &roots_count) != napi_ok || roots_count > OE_MAX_ROOTS ||
		napi_get_array_length(env, descriptors, &descriptors_count) != napi_ok || descriptors_count != roots_count ||
		napi_get_array_length(env, closure, &closure_count) != napi_ok || closure_count >= OE_MAX_ARTIFACTS ||
		napi_get_array_length(env, files, &files_count) != napi_ok || files_count != closure_count + 1) { errno = EINVAL; return -1; }
	struct stat storage;
	if (fstat(host->storage, &storage) < 0) return -1;
	unsigned remaining = host->inode_limit;
	if (sandbox_tree(host->tools, true, mount_identity(host->tools), &remaining, 0) < 0) return -1;
	for (unsigned i = 0; i < roots_count; i++) {
		napi_value root, value;
		char access[16];
		int32_t fd;
		SandboxPath *target = &host->roots[i];
		if (napi_get_element(env, roots, i, &root) != napi_ok || napi_get_element(env, descriptors, i, &value) != napi_ok ||
			napi_get_value_int32(env, value, &fd) != napi_ok || fd < 0 ||
			!named_string(env, root, "path", target->path, sizeof(target->path)) || !sandbox_path(target->path) ||
			!named_string(env, root, "access", access, sizeof(access)) || (strcmp(access, "read-only") && strcmp(access, "read-write")) ||
			expected_directory(fd, target->path) < 0) { errno = EINVAL; return -1; }
		target->writable = !strcmp(access, "read-write");
		struct stat st;
		if (fstat(fd, &st) < 0 || !S_ISDIR(st.st_mode) ||
			(target->writable && (st.st_dev != storage.st_dev || st.st_uid != getuid() || (st.st_mode & 0077)))) { errno = EPERM; return -1; }
		remaining = host->inode_limit;
		if (sandbox_tree(fd, false, mount_identity(fd), &remaining, 0) < 0) return -1;
		target->fd = duplicate_fd(fd);
		if (target->fd < 0) return -1;
		host->root_count++;
	}
	for (unsigned i = 0; i < files_count; i++) {
		napi_value artifact = runtime, value;
		int32_t fd;
		SandboxPath *target = &host->artifacts[i];
		if ((i && napi_get_element(env, closure, i - 1, &artifact) != napi_ok) ||
			napi_get_element(env, files, i, &value) != napi_ok || napi_get_value_int32(env, value, &fd) != napi_ok || fd < 0 ||
			!named_string(env, artifact, "path", target->path, sizeof(target->path)) || !sandbox_path(target->path) ||
			expected_directory(fd, target->path) < 0) { errno = EINVAL; return -1; }
		struct stat st;
		if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid || st.st_nlink != 1 || (st.st_mode & (0022 | S_ISUID | S_ISGID))) { errno = EPERM; return -1; }
		target->fd = duplicate_fd(fd);
		if (target->fd < 0) return -1;
		host->artifact_count++;
	}
	return 0;
}

static int sandbox_arg(Launch *launch, const char *text) {
	size_t bytes = strlen(text) + 1;
	if (launch->argc == OE_MAX_ARGS || bytes > launch->host->argv_limit - launch->argument_bytes) { errno = E2BIG; return -1; }
	char *copy = strdup(text);
	if (!copy) return -1;
	launch->argv[launch->argc++] = copy;
	launch->argument_bytes += bytes;
	return 0;
}

static int sandbox_mount(Launch *launch, int fd, const char *destination, bool writable, int *sources) {
	if (launch->mapping_count == OE_MAX_MAPPINGS) { errno = EMFILE; return -1; }
	char number[16];
	snprintf(number, sizeof(number), "%u", launch->mapping_count);
	sources[launch->mapping_count++] = fd;
	return sandbox_arg(launch, writable ? "--bind-fd" : "--ro-bind-fd") < 0 ||
		sandbox_arg(launch, number) < 0 || sandbox_arg(launch, destination) < 0 ? -1 : 0;
}

static int sandbox_interpreter(Launch *launch, int executable, int *sources) {
	Elf64_Ehdr header;
	ssize_t size = pread(executable, &header, sizeof(header), 0);
	if (size < 0) return -1;
	if (size < SELFMAG || memcmp(header.e_ident, ELFMAG, SELFMAG)) return 0;
	if (size != sizeof(header) || header.e_ident[EI_CLASS] != ELFCLASS64 || header.e_ident[EI_DATA] != ELFDATA2LSB ||
		header.e_phentsize != sizeof(Elf64_Phdr) || header.e_phnum > 128 || header.e_phoff > OE_MAX_JOURNAL) { errno = ENOEXEC; return -1; }
	for (unsigned i = 0; i < header.e_phnum; i++) {
		Elf64_Phdr segment;
		if (pread(executable, &segment, sizeof(segment), (off_t)(header.e_phoff + i * sizeof(segment))) != sizeof(segment)) { errno = ENOEXEC; return -1; }
		if (segment.p_type != PT_INTERP) continue;
		char path[PATH_MAX];
		if (segment.p_filesz < 2 || segment.p_filesz > sizeof(path) || segment.p_offset > OE_MAX_JOURNAL ||
			pread(executable, path, (size_t)segment.p_filesz, (off_t)segment.p_offset) != (ssize_t)segment.p_filesz ||
			path[segment.p_filesz - 1] || strlen(path) + 1 != segment.p_filesz || !sandbox_path(path)) { errno = ENOEXEC; return -1; }
		struct stat interpreter;
		if (stat(path, &interpreter) < 0) return -1;
		for (unsigned j = 0; j < launch->host->artifact_count; j++) {
			SandboxPath *artifact = &launch->host->artifacts[j];
			struct stat held;
			if (fstat(artifact->fd, &held) < 0) return -1;
			if (held.st_dev == interpreter.st_dev && held.st_ino == interpreter.st_ino) {
				if (!strcmp(path, artifact->path)) return 0;
				return sandbox_mount(launch, artifact->fd, path, false, sources);
			}
		}
		errno = ENOEXEC; return -1;
	}
	return 0;
}

/* The input is a payload request, never bubblewrap argv or a caller FD list. */
static int build_sandbox(napi_env env, Launch *launch, napi_value request, int *sources, int filter) {
	Host *host = launch->host;
	char command[PATH_MAX], cwd[PATH_MAX], argv0[PATH_MAX];
	napi_value roots, args, environment, value;
	uint32_t root_count, argument_count, environment_count;
	bool read_only;
	if (!named_string(env, request, "command", command, sizeof(command)) || !sandbox_path(command) ||
		!named_string(env, request, "cwd", cwd, sizeof(cwd)) || !sandbox_path(cwd) ||
		!named_string(env, request, "argv0", argv0, sizeof(argv0)) ||
		napi_get_named_property(env, request, "readOnly", &value) != napi_ok || napi_get_value_bool(env, value, &read_only) != napi_ok ||
		napi_get_named_property(env, request, "roots", &roots) != napi_ok || napi_get_array_length(env, roots, &root_count) != napi_ok || root_count > host->root_count ||
		napi_get_named_property(env, request, "args", &args) != napi_ok || napi_get_array_length(env, args, &argument_count) != napi_ok || argument_count > 512 ||
		napi_get_named_property(env, request, "environment", &environment) != napi_ok || napi_get_array_length(env, environment, &environment_count) != napi_ok || environment_count > 64) { errno = EINVAL; return -1; }
	launch->argv = calloc(OE_MAX_ARGS + 1, sizeof(char *));
	if (!launch->argv) return -1;
	const char *prefix[] = {"bwrap", "--unshare-user", "--unshare-pid", "--unshare-cgroup", "--unshare-ipc", "--unshare-net", "--unshare-uts",
		"--disable-userns", "--assert-userns-disabled", "--new-session", "--cap-drop", "ALL", "--clearenv",
		"--symlink", "/usr/bin", "/bin", "--symlink", "/usr/sbin", "/sbin", "--symlink", "/usr/lib", "/lib", "--symlink", "/usr/lib64", "/lib64"};
	for (unsigned i = 0; i < sizeof(prefix) / sizeof(prefix[0]); i++) if (sandbox_arg(launch, prefix[i]) < 0) return -1;
	if (sandbox_mount(launch, host->tools, host->tools_path, false, sources) < 0) return -1;
	for (unsigned i = 0; i < host->artifact_count; i++) if (sandbox_mount(launch, host->artifacts[i].fd, host->artifacts[i].path, false, sources) < 0) return -1;
	bool cwd_allowed = beneath(host->tools_path, cwd);
	const char *home = "/tmp";
	unsigned seen = 0;
	for (unsigned i = 0; i < root_count; i++) {
		double index;
		if (napi_get_element(env, roots, i, &value) != napi_ok || napi_get_value_double(env, value, &index) != napi_ok ||
			index != index || index < 0 || index >= host->root_count || index != (unsigned)index || (seen & (1U << (unsigned)index))) { errno = EINVAL; return -1; }
		seen |= 1U << (unsigned)index;
		SandboxPath *root = &host->roots[(unsigned)index];
		bool writable = root->writable && !read_only;
		if (!admission_root_allowed(launch, (unsigned)index, writable)) { errno = EPERM; return -1; }
		if (writable) launch->write_roots |= 1U << (unsigned)index;
		unsigned remaining = host->inode_limit;
		if (expected_directory(root->fd, root->path) < 0 || sandbox_tree(root->fd, false, mount_identity(root->fd), &remaining, 0) < 0 ||
			sandbox_mount(launch, root->fd, root->path, root->writable && !read_only, sources) < 0) return -1;
		if (root->writable && !read_only) {
			home = root->path;
			launch->mutating = true;
		}
		cwd_allowed |= beneath(root->path, cwd);
	}
	napi_value mounts;
	napi_valuetype mounts_type;
	if (napi_get_named_property(env, request, "mounts", &mounts) != napi_ok || napi_typeof(env, mounts, &mounts_type) != napi_ok) { errno = EINVAL; return -1; }
	if (mounts_type != napi_undefined) {
		uint32_t count;
		if (root_count || napi_get_array_length(env, mounts, &count) != napi_ok || !count || count > OE_MAX_ROOTS) { errno = EINVAL; return -1; }
		for (unsigned i = 0; i < count; i++) {
			napi_value mount;
			unsigned index;
			char relative[PATH_MAX], access[16];
			if (napi_get_element(env, mounts, i, &mount) != napi_ok || !get_u32(env, mount, "root", &index) || index >= host->root_count ||
				!named_string(env, mount, "relativePath", relative, sizeof(relative)) || relative[0] == '/' ||
				!named_string(env, mount, "access", access, sizeof(access)) || (strcmp(access, "read-only") && strcmp(access, "read-write"))) { errno = EINVAL; return -1; }
			SandboxPath *source = &host->roots[index];
			SandboxPath *held = &launch->subroots[launch->subroot_count];
			int length = snprintf(held->path, sizeof(held->path), "%s%s%s", source->path, relative[0] ? "/" : "", relative);
			if (length < 0 || (size_t)length >= sizeof(held->path) || !sandbox_path(held->path)) { errno = EINVAL; return -1; }
			for (unsigned j = 0; j < launch->subroot_count; j++) {
				if (beneath(launch->subroots[j].path, held->path) || beneath(held->path, launch->subroots[j].path)) { errno = EINVAL; return -1; }
			}
			held->writable = !strcmp(access, "read-write") && !read_only;
			if (!admission_root_allowed(launch, index, held->writable) || expected_directory(source->fd, source->path) < 0) { errno = EPERM; return -1; }
			struct open_how how = {.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
				.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV};
			held->fd = (int)syscall(SYS_openat2, source->fd, relative[0] ? relative : ".", &how, sizeof(how));
			if (held->fd < 0) return -1;
			launch->subroot_count++;
			struct stat st;
			unsigned remaining = host->inode_limit;
			if (fstat(held->fd, &st) < 0 || (held->writable && (st.st_uid != getuid() || (st.st_mode & 0077))) ||
				expected_directory(held->fd, held->path) < 0 || sandbox_tree(held->fd, false, mount_identity(held->fd), &remaining, 0) < 0 ||
				sandbox_mount(launch, held->fd, held->path, held->writable, sources) < 0) { errno = EPERM; return -1; }
			seen |= 1U << index;
			if (held->writable) { launch->write_roots |= 1U << index; launch->mutating = true; home = held->path; }
			cwd_allowed |= beneath(held->path, cwd);
		}
	}
	launch->read_roots = seen;
	launch->executable = admission_command(launch, command);
	if (!cwd_allowed || launch->executable < 0) { errno = EPERM; return -1; }
	if (sandbox_interpreter(launch, launch->executable, sources) < 0 ||
		sandbox_mount(launch, launch->executable, command, false, sources) < 0) return -1;
	const char *finish[] = {"--proc", "/proc", "--dev", "/dev", "--remount-ro", "/dev", "--dir", "/tmp",
		"--setenv", "HOME", home, "--setenv", "TMPDIR", home, "--setenv", "LANG", "C", "--setenv", "LC_ALL", "C"};
	for (unsigned i = 0; i < sizeof(finish) / sizeof(finish[0]); i++) if (sandbox_arg(launch, finish[i]) < 0) return -1;
	for (unsigned i = 0; i < environment_count; i++) {
		char text[8192];
		if (napi_get_element(env, environment, i, &value) != napi_ok || !get_string(env, value, text, sizeof(text))) { errno = EINVAL; return -1; }
		char *separator = strchr(text, '=');
		if (!separator || separator == text) { errno = EINVAL; return -1; }
		*separator++ = 0;
		for (const char *p = text; *p; p++) if (!((*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9' && p != text) || *p == '_')) { errno = EINVAL; return -1; }
		if (!strncmp(text, "LD_", 3) || !strcmp(text, "GLIBC_TUNABLES") || !strcmp(text, "NODE_OPTIONS") ||
			!strcmp(text, "BUN_OPTIONS") || !strcmp(text, "BASH_ENV") || !strcmp(text, "ENV") || !strcmp(text, "PYTHONPATH")) { errno = EPERM; return -1; }
		if (sandbox_arg(launch, "--setenv") < 0 || sandbox_arg(launch, text) < 0 || sandbox_arg(launch, separator) < 0) return -1;
	}
	if (launch->mapping_count == OE_MAX_MAPPINGS) { errno = EMFILE; return -1; }
	char filter_number[16];
	snprintf(filter_number, sizeof(filter_number), "%u", launch->mapping_count);
	sources[launch->mapping_count++] = filter;
	const char *end[] = {"--remount-ro", "/", "--seccomp", filter_number, "--chdir", cwd, "--argv0", argv0, "--", command};
	for (unsigned i = 0; i < sizeof(end) / sizeof(end[0]); i++) if (sandbox_arg(launch, end[i]) < 0) return -1;
	for (unsigned i = 0; i < argument_count; i++) {
		size_t length;
		if (napi_get_element(env, args, i, &value) != napi_ok || napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length >= host->argv_limit) { errno = EINVAL; return -1; }
		char *text = malloc(length + 1);
		if (!text) return -1;
		int result = get_string(env, value, text, length + 1) ? sandbox_arg(launch, text) : -1;
		free(text);
		if (result < 0) return -1;
	}
	return 0;
}

#endif
