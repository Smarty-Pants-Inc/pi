/* Private original-H transport. No slot protocol, daemon, worker or SDK port.
 * Source selects the retained graph; this boundary checks actual process/FD
 * identity, one-shot packets and native owner/borrow/drain custody. */
#include <sys/un.h>

typedef struct HMeterBorrow HMeterBorrow;
struct HMeter {
	int socket, directory, peer, aggregate;
	bool started, offered, accepted, accept_attempted, close_attempted, failed, uncertain;
	bool borrowed, returned;
	unsigned slot;
	uint64_t generation, device, inode, child_start, controller_start, receive_deadline, close_deadline;
	pid_t child, controller;
	uint64_t namespace_device[8], namespace_inode[8];
	char boot[40], allocation[65];
	HMeterBorrow *borrow;
};
struct HMeterBorrow {
	Host *host;
	int fd;
	bool returned;
	napi_ref host_ref;
};
static const napi_type_tag h_borrow_tag = {0x484d455445524231ULL, 1};
static const char *h_namespaces[] = {"cgroup", "ipc", "net", "mnt", "pid", "user", "uts", "time"};

static bool h_u64(napi_env env, napi_value value, const char *name, uint64_t *out) {
	char text[32], *end;
	if (!named_string(env, value, name, text, sizeof(text)) || !text[0] || (text[0] == '0' && text[1])) return false;
	for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;
	errno = 0; unsigned long long n = strtoull(text, &end, 10);
	if (errno || *end) return false;
	*out = (uint64_t)n; return true;
}
static bool h_close_fd(HMeter *h, int *fd) {
	if (*fd < 0) return true;
	int closing = *fd; *fd = -1; /* Never retry a recycled descriptor. */
	if (close(closing) == 0) return true;
	h->uncertain = h->failed = true; return false;
}
static bool h_meter_custody(Host *host) {
	HMeter *h = host->h_meter;
	return h && (h->socket >= 0 || h->directory >= 0 || h->peer >= 0 || h->aggregate >= 0 ||
		(h->borrow && h->borrow->fd >= 0) || h->uncertain);
}
static void h_meter_destroy(Host *host) {
	if (host->h_meter && !h_meter_custody(host)) { free(host->h_meter); host->h_meter = NULL; }
}
/* CI owns the missing admitted ORIGINAL C executable/loader-closure selector.
 * Intentionally unconditional production refusal. No argument, callback, root
 * UID, observed hash or controllerSource.py can enable this branch. CI must
 * supply the original private enforcement correspondence before replacement. */
static bool h_original_sender_runtime(Host *host, HMeter *h) {
	(void)host; (void)h; errno = ENOTSUP; return false;
}
static bool h_identity(Host *host, HMeter *h, bool closing) {
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now) < 0 || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000L ||
		(uint64_t)now.tv_sec > UINT64_MAX / 1000000000ULL) return false;
	uint64_t ns = (uint64_t)now.tv_sec * 1000000000ULL;
	if (ns > UINT64_MAX - (uint64_t)now.tv_nsec) { errno = EOVERFLOW; return false; }
	ns += (uint64_t)now.tv_nsec;
	if (ns >= (closing ? h->close_deadline : h->receive_deadline) || getpid() != h->child ||
		pid_start(getpid()) != h->child_start || pid_start(h->controller) != h->controller_start) { errno = ESTALE; return false; }
	char boot[40];
	if (read_small_at(AT_FDCWD, "/proc/sys/kernel/random/boot_id", boot, sizeof(boot) - 1) < 0) return false;
	boot[strcspn(boot, "\n")] = 0;
	if (strcmp(boot, h->boot)) { errno = ESTALE; return false; }
	for (unsigned i = 0; i < 8; i++) {
		char path[80]; struct stat st;
		snprintf(path, sizeof(path), "/proc/self/ns/%s", h_namespaces[i]);
		if (stat(path, &st) < 0 || (uint64_t)st.st_dev != h->namespace_device[i] ||
			(uint64_t)st.st_ino != h->namespace_inode[i]) { errno = ESTALE; return false; }
	}
	char peer_time[80]; struct stat time_ns, exe, selected;
	snprintf(peer_time, sizeof(peer_time), "/proc/%ld/ns/time", (long)h->controller);
	if (stat(peer_time, &time_ns) < 0 || (uint64_t)time_ns.st_dev != h->namespace_device[7] ||
		(uint64_t)time_ns.st_ino != h->namespace_inode[7] || host->artifact_count == 0 ||
		stat("/proc/self/exe", &exe) < 0 || fstat(host->artifacts[0].fd, &selected) < 0 ||
		exe.st_dev != selected.st_dev || exe.st_ino != selected.st_ino) { errno = ESTALE; return false; }
	if (h->peer >= 0) {
		struct pollfd peer = {.fd = h->peer, .events = POLLIN};
		if (poll(&peer, 1, 0) != 0) { errno = ESTALE; return false; }
	}
	return h_original_sender_runtime(host, h);
}
/* Collect ALL installed rights before rejecting any packet. MSG_CTRUNC also
 * rejects; Linux closes rights that do not fit the ancillary buffer. */
static ssize_t h_packet(HMeter *h, char *bytes, size_t capacity, int *right) {
	int installed[253]; size_t count = 0;
	union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(253 * sizeof(int))]; } control;
	memset(&control, 0, sizeof(control));
	struct iovec iov = {bytes, capacity};
	struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
	*right = -1;
	ssize_t n = recvmsg(h->socket, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
	if (n < 0) return n;
	bool bad = n <= 0 || n > 4096 || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC));
	for (struct cmsghdr *c = CMSG_FIRSTHDR(&message); c; c = CMSG_NXTHDR(&message, c)) {
		size_t offset = (size_t)((unsigned char *)c - control.bytes);
		if (c->cmsg_len < CMSG_LEN(0) || c->cmsg_len > message.msg_controllen - offset) { bad = true; break; }
		size_t length = c->cmsg_len - CMSG_LEN(0);
		if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) { bad = true; continue; }
		if (length % sizeof(int)) bad = true;
		for (size_t i = 0; i + sizeof(int) <= length; i += sizeof(int)) {
			int fd; memcpy(&fd, (unsigned char *)CMSG_DATA(c) + i, sizeof(fd));
			if (count < 253) installed[count++] = fd;
			else { bad = true; (void)h_close_fd(h, &fd); }
		}
	}
	if (count != 1) bad = true;
	if (!bad) { *right = installed[0]; return n; }
	for (size_t i = 0; i < count; i++) (void)h_close_fd(h, &installed[i]);
	errno = EPROTO; return -1;
}
static bool h_no_extra(HMeter *h) {
	char bytes[4097]; int right;
	ssize_t n = h_packet(h, bytes, sizeof(bytes), &right);
	if (right >= 0) (void)h_close_fd(h, &right);
	if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
	errno = EPROTO; return false; /* EOF is NOT H closure. */
}
static napi_value h_start(napi_env env, napi_callback_info info) {
	size_t argc = 3; napi_value args[3], namespaces, result; unsigned directory, child, controller;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Host *host = argc == 3 ? get_host(env, args[0]) : NULL;
	if (!host || host->closed || host->closing || host->failed || host->h_meter) return failure(env, "OWNER_H_START_ONCE", EPERM);
	HMeter *h = calloc(1, sizeof(*h));
	if (!h) return failure(env, "OWNER_H_MEMORY", ENOMEM);
	h->socket = h->directory = h->peer = h->aggregate = -1; h->started = true; host->h_meter = h;
	uint64_t dir_device, dir_inode;
	if (napi_get_value_uint32(env, args[1], &directory) != napi_ok || directory > INT_MAX ||
		!get_u32(env, args[2], "childPid", &child) || !child || child > INT_MAX ||
		!get_u32(env, args[2], "controllerPid", &controller) || !controller || controller > INT_MAX ||
		!h_u64(env, args[2], "childStartTicks", &h->child_start) || !h->child_start ||
		!h_u64(env, args[2], "controllerStartTicks", &h->controller_start) || !h->controller_start ||
		!h_u64(env, args[2], "device", &h->device) || !h_u64(env, args[2], "inode", &h->inode) || !h->inode ||
		!h_u64(env, args[2], "directoryDevice", &dir_device) || !h_u64(env, args[2], "directoryInode", &dir_inode) ||
		!h_u64(env, args[2], "receiveDeadlineNs", &h->receive_deadline) ||
		!h_u64(env, args[2], "closeDeadlineNs", &h->close_deadline) || h->close_deadline < h->receive_deadline ||
		!named_string(env, args[2], "bootId", h->boot, sizeof(h->boot)) ||
		!named_string(env, args[2], "allocation", h->allocation, sizeof(h->allocation)) || !hex_string(h->allocation, 64) ||
		napi_get_named_property(env, args[2], "namespaces", &namespaces) != napi_ok) {
		h->failed = true; return failure(env, "OWNER_H_SELECTION", EINVAL);
	}
	h->child = (pid_t)child; h->controller = (pid_t)controller;
	for (unsigned i = 0; i < 8; i++) {
		napi_value ns;
		if (napi_get_named_property(env, namespaces, h_namespaces[i], &ns) != napi_ok ||
			!h_u64(env, ns, "device", &h->namespace_device[i]) || !h_u64(env, ns, "inode", &h->namespace_inode[i])) {
			h->failed = true; return failure(env, "OWNER_H_NAMESPACE_SELECTION", EINVAL);
		}
	}
	struct stat root;
	if (fstat((int)directory, &root) < 0 || !S_ISDIR(root.st_mode) || root.st_uid != 0 || (root.st_mode & 0022) ||
		(uint64_t)root.st_dev != dir_device || (uint64_t)root.st_ino != dir_inode) {
		h->failed = true; return failure(env, "OWNER_H_RECEIVING_ROOT", EPERM);
	}
	/* Enforcement CLOSED until CI supplies the admitted original C closure. */
	if (!h_original_sender_runtime(host, h)) { h->failed = true; return failure(env, "ORIGINAL_H_SENDER_EXECUTABLE_SELECTOR_ABSENT", ENOTSUP); }
	if (!h_identity(host, h, false)) goto refused;
	h->directory = duplicate_fd((int)directory);
	h->peer = (int)syscall(SYS_pidfd_open, h->controller, 0);
	if (h->directory < 0 || h->peer < 0 || !h_identity(host, h, false)) goto refused;
	struct sockaddr_un address = {.sun_family = AF_UNIX};
	int length = snprintf(address.sun_path, sizeof(address.sun_path), "/proc/self/fd/%d/ordinary-h-meter.sock", h->directory);
	if (length < 0 || (size_t)length >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; goto refused; }
	struct stat socket_file;
	if (fstatat(h->directory, "ordinary-h-meter.sock", &socket_file, AT_SYMLINK_NOFOLLOW) < 0 ||
		!S_ISSOCK(socket_file.st_mode) || socket_file.st_uid != getuid() || socket_file.st_gid != getgid() ||
		(socket_file.st_mode & 0777) != 0600) { errno = EPERM; goto refused; }
	h->socket = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (h->socket < 0 || connect(h->socket, (struct sockaddr *)&address, sizeof(address)) < 0) goto refused;
	struct ucred peer; socklen_t size = sizeof(peer);
	if (getsockopt(h->socket, SOL_SOCKET, SO_PEERCRED, &peer, &size) < 0 || size != sizeof(peer) ||
		peer.pid != h->controller || peer.uid != 0 || !h_identity(host, h, false)) { errno = EPERM; goto refused; }
	NAPI_CALL(env, napi_get_undefined(env, &result)); return result;
refused:
	h->failed = true; return failure(env, "OWNER_H_CONNECT", errno);
}
static napi_value h_poll(napi_env env, napi_callback_info info) {
	size_t argc = 1; napi_value arg, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
	Host *host = argc == 1 ? get_host(env, arg) : NULL; HMeter *h = host ? host->h_meter : NULL;
	if (!h || h->failed || h->offered || !h_identity(host, h, false)) return failure(env, "OWNER_H_RECEIVE_PHASE", ESTALE);
	char bytes[4097]; int right;
	ssize_t size = h_packet(h, bytes, sizeof(bytes), &right);
	if (size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { NAPI_CALL(env, napi_get_undefined(env, &result)); return result; }
	if (size < 0) { h->failed = true; return failure(env, "OWNER_H_PACKET", errno); }
	h->offered = true; h->aggregate = right;
	struct stat st; struct statfs fs, effect_fs;
	int flags = fcntl(right, F_GETFL);
	/* SCM_RIGHTS preserves the sender's file/mount reference. Namespace-local
	 * mount IDs need NOT equal across the original read-only bind. Check the
	 * actual original receiver namespace, admitted local effect mount and SAME
	 * cgroup superblock plus the independently selected H device/inode instead. */
	if (flags < 0 || (flags & O_ACCMODE) != O_RDONLY || (flags & O_PATH) || fstat(right, &st) < 0 || !S_ISDIR(st.st_mode) || (uint64_t)st.st_dev != h->device || (uint64_t)st.st_ino != h->inode ||
		fstatfs(right, &fs) < 0 || fstatfs(host->cgroup, &effect_fs) < 0 || fs.f_type != CGROUP2_SUPER_MAGIC ||
		effect_fs.f_type != CGROUP2_SUPER_MAGIC || memcmp(&fs.f_fsid, &effect_fs.f_fsid, sizeof(fs.f_fsid)) ||
		h->device != host->cgroup_device || !h_identity(host, h, false) || !h_no_extra(h)) {
		h->failed = true; return failure(env, "OWNER_H_AGGREGATE", ESTALE);
	}
	NAPI_CALL(env, napi_create_buffer_copy(env, (size_t)size, bytes, NULL, &result)); return result;
}
static napi_value h_cancel(napi_env env, napi_callback_info info) {
	size_t argc = 1; napi_value arg, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
	Host *host = argc == 1 ? get_host(env, arg) : NULL; HMeter *h = host ? host->h_meter : NULL;
	if (!h) return failure(env, "OWNER_H_CANCEL", EINVAL);
	h->failed = true;
	bool closed = true;
	if (h->borrow && !h->borrow->returned) { h->uncertain = true; closed = false; }
	closed = h_close_fd(h, &h->aggregate) && closed;
	closed = h_close_fd(h, &h->socket) && closed;
	closed = h_close_fd(h, &h->peer) && closed;
	closed = h_close_fd(h, &h->directory) && closed;
	if (!closed) return failure(env, "OWNER_H_CANCEL_UNKNOWN", EIO);
	NAPI_CALL(env, napi_get_undefined(env, &result)); return result;
}
static bool h_send(napi_env env, HMeter *h, napi_value packet) {
	void *bytes; size_t length; bool buffer = false;
	if (napi_is_buffer(env, packet, &buffer) != napi_ok || !buffer ||
		napi_get_buffer_info(env, packet, &bytes, &length) != napi_ok || !length || length > 4096) { errno = EINVAL; return false; }
	/* One attempt, no EINTR/EAGAIN retry. Unknown send remains release-held. */
	ssize_t sent = send(h->socket, bytes, length, MSG_DONTWAIT | MSG_NOSIGNAL);
	if (sent != (ssize_t)length) { h->failed = h->uncertain = true; if (sent >= 0) errno = EIO; return false; }
	return true;
}
static napi_value h_accept(napi_env env, napi_callback_info info) {
	size_t argc = 2; napi_value args[2], result; LeaseRef *ref;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Owner *owner = argc == 2 ? get_owner(env, args[0], &ref, false) : NULL;
	HMeter *h = owner ? ref->host->h_meter : NULL;
	if (!h || h->failed || !h->offered || h->accept_attempted || !owner->admitted ||
		strcmp(owner->allocation.id, h->allocation) || !h_identity(ref->host, h, false) || !h_no_extra(h))
		return failure(env, "OWNER_H_BINDING", ESTALE);
	h->accept_attempted = true; h->slot = ref->slot; h->generation = ref->generation;
	if (!h_send(env, h, args[1])) return failure(env, "OWNER_H_ACCEPT_UNKNOWN", errno);
	h->accepted = true;
	if (!h_identity(ref->host, h, false)) { h->failed = h->uncertain = true; return failure(env, "OWNER_H_ACCEPT_LATE", ESTALE); }
	NAPI_CALL(env, napi_get_undefined(env, &result)); return result;
}
static void h_finalize_borrow(napi_env env, void *data, void *hint) {
	(void)hint; HMeterBorrow *borrow = data;
	if (!borrow->returned) { borrow->host->h_meter->uncertain = true; return; }
	napi_delete_reference(env, borrow->host_ref); free(borrow);
}
static napi_value h_borrow(napi_env env, napi_callback_info info) {
	size_t argc = 1; napi_value arg, result, host_value; LeaseRef *ref;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
	Owner *owner = argc == 1 ? get_owner(env, arg, &ref, false) : NULL;
	HMeter *h = owner ? ref->host->h_meter : NULL;
	if (!h || !h->accepted || h->failed || h->borrowed || h->close_attempted || h->slot != ref->slot ||
		h->generation != ref->generation || !h_identity(ref->host, h, true) || !h_no_extra(h))
		return failure(env, "OWNER_H_BORROW_ONCE", ESTALE);
	h->borrowed = true;
	HMeterBorrow *borrow = calloc(1, sizeof(*borrow));
	if (!borrow) { h->failed = true; return failure(env, "OWNER_H_MEMORY", ENOMEM); }
	borrow->host = ref->host; borrow->fd = duplicate_fd(h->aggregate); h->borrow = borrow;
	if (borrow->fd < 0) { h->failed = true; return failure(env, "OWNER_H_BORROW_FD", errno); }
	NAPI_CALL(env, napi_get_reference_value(env, ref->host_ref, &host_value));
	NAPI_CALL(env, napi_create_reference(env, host_value, 1, &borrow->host_ref));
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, borrow, h_finalize_borrow, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &h_borrow_tag));
	const char *names[] = {"descriptor", "device", "inode"};
	uint64_t values[] = {(uint64_t)borrow->fd, h->device, h->inode};
	for (unsigned i = 0; i < 3; i++) {
		if (values[i] > 9007199254740991ULL) { h->failed = true; return failure(env, "OWNER_H_SAFE_INTEGER", EOVERFLOW); }
		napi_value value; NAPI_CALL(env, napi_create_double(env, (double)values[i], &value));
		napi_property_descriptor property = {.utf8name = names[i], .value = value, .attributes = napi_enumerable};
		NAPI_CALL(env, napi_define_properties(env, result, 1, &property));
	}
	return result;
}
static napi_value h_return(napi_env env, napi_callback_info info) {
	size_t argc = 2; napi_value args[2], result; bool tagged = false, failed; void *pointer = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	if (argc != 2 || napi_check_object_type_tag(env, args[0], &h_borrow_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, args[0], &pointer) != napi_ok || napi_get_value_bool(env, args[1], &failed) != napi_ok)
		return failure(env, "OWNER_H_ORIGINAL_BORROW", EINVAL);
	HMeterBorrow *borrow = pointer; HMeter *h = borrow->host->h_meter;
	if (!h || h->borrow != borrow || borrow->returned || getpid() != h->child || pid_start(getpid()) != h->child_start)
		return failure(env, "OWNER_H_BORROW_RETURN_ONCE", ESTALE);
	borrow->returned = true; h->borrow = NULL;
	bool closed = h_close_fd(h, &borrow->fd);
	if (!closed) { h->failed = h->uncertain = true; return failure(env, "OWNER_H_BORROW_CLOSE_UNKNOWN", EIO); }
	if (failed) h->failed = h->uncertain = true;
	else h->returned = true;
	NAPI_CALL(env, napi_get_undefined(env, &result)); return result;
}
static napi_value h_finish(napi_env env, napi_callback_info info) {
	size_t argc = 2; napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Host *host = argc == 2 ? get_host(env, args[0]) : NULL; HMeter *h = host ? host->h_meter : NULL;
	if (!h || h->failed || h->uncertain || !h->accepted || h->close_attempted || !h->borrowed || !h->returned ||
		!h_identity(host, h, true) || !h_no_extra(h)) return failure(env, "OWNER_H_CLOSE_PHASE", ESTALE);
	for (unsigned i = 0; i < host->owner_limit; i++) if (host->owners[i].active || host->owners[i].lifecycle ||
		host->holders[i].started || host->holders[i].failed) return failure(env, "OWNER_H_NATIVE_DRAIN_REQUIRED", EBUSY);
	h->close_attempted = true;
	if (!h_close_fd(h, &h->aggregate)) return failure(env, "OWNER_H_CLOSE_UNKNOWN", EIO);
	if (!h_identity(host, h, true)) { h->failed = h->uncertain = true; return failure(env, "OWNER_H_CLOSE_LATE", ESTALE); }
	if (!h_send(env, h, args[1])) return failure(env, "OWNER_H_CLOSED_SEND_UNKNOWN", errno);
	if (!h_identity(host, h, true)) { h->failed = h->uncertain = true; return failure(env, "OWNER_H_CLOSED_SEND_LATE", ESTALE); }
	bool closed = h_close_fd(h, &h->socket);
	closed = h_close_fd(h, &h->peer) && closed;
	closed = h_close_fd(h, &h->directory) && closed;
	if (!closed) return failure(env, "OWNER_H_CONTROL_CLOSE_UNKNOWN", EIO);
	NAPI_CALL(env, napi_get_undefined(env, &result)); return result;
}
