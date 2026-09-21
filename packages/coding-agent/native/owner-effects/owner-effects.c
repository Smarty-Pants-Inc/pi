#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <linux/sched.h>
#include <linux/stat.h>
#include <poll.h>
#include <stdatomic.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/timerfd.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "linux-syscalls.h"
#include "owner-record.h"

/* Private ABI. Nothing in this module enrolls a session or changes host policy. */
#define OE_MAX_OWNERS 32
/* Separate, nonrenewable maxima: eight inference + eight admitted count sends. */
#define OE_MAX_PROVIDER_SOCKETS 16
#define OE_MAX_JOURNAL (16U * 1024U * 1024U)
#define OE_MAX_CONTROL 65536U
#define OE_MAX_ARGS 2048U
#define OE_MAX_MAPPINGS 288U
#define OE_MAX_ROOTS 16U
#define OE_MAX_ARTIFACTS 257U
#define OE_MAX_ARG_BYTES 131072U
#define OE_TAG_HOST 0x5c522be42b19fa01ULL
#define OE_TAG_LEASE 0x5c522be42b19fa02ULL
static const napi_type_tag host_tag = {OE_TAG_HOST, 1};
static const napi_type_tag lease_tag = {OE_TAG_LEASE, 1};
static atomic_bool host_registered = false;

typedef struct {
	unsigned operation;
	unsigned slot;
	uint64_t generation;
	uint64_t deadline_ms;
	uint64_t expires_ms;
	const atomic_bool *cancelled;
	char name[192];
	unsigned connection;
	struct sockaddr_storage peer;
	socklen_t peer_length;
} LockRequest;
typedef struct { int error; bool closed; uint64_t generation; uint64_t device; uint64_t inode; } LockReply;
typedef struct {
	int fd;
	uint64_t generation;
} LockSlot;

typedef struct {
	int fd;
	bool writable;
	char path[PATH_MAX];
} SandboxPath;

typedef struct {
	pthread_t thread;
	int control;
	int worker;
	unsigned slot;
	bool started;
	bool failed;
	uint64_t device;
	uint64_t inode;
	atomic_bool expired;
	atomic_bool expiry_failed;
} LockHolder;

typedef struct Host Host;
typedef struct Launch Launch;
typedef struct Admission Admission;
typedef struct OwnerCredential OwnerCredential;
typedef struct Operation Operation;
typedef struct LifecycleTask LifecycleTask;
typedef struct {
	Host *host;
	unsigned slot;
	uint64_t generation;
	napi_ref host_ref;
} LeaseRef;

typedef struct {
	bool active;
	atomic_bool sealed;
	bool uncertain;
	bool recovering;
	bool retired;
	bool admitted;
	bool release_started;
	/* Main-thread ownership of one retained native lifecycle operation. */
	LifecycleTask *lifecycle;
	uint32_t mutation_flags;
	uint64_t generation;
	uint64_t lock_device;
	uint64_t lock_inode;
	atomic_uint_fast64_t stop_generation;
	/* One nonrenewable seal-to-release budget, not a syscall preemption guarantee. */
	atomic_uint_fast64_t close_deadline;
	uint64_t journal_size;
	uint64_t journal_device;
	uint64_t journal_inode;
	char lock_name[192];
	char journal_name[192];
	char grant[65];
	OwnerRecord prior;
	OwnerAllocation allocation;
	uint64_t allocation_deadline;
	LockHolder *holder;
	int directory;
	int effects;
	int group;
	char group_name[40];
	char record_name[192];
	Launch *launches;
	unsigned launch_count;
	unsigned sequence;
	unsigned operations;
	unsigned mutating_operations;
	unsigned mutating_launches;
	unsigned remote_operations;
	unsigned provider_sockets;
	Admission *admission;
	napi_ref admission_ref;
	OwnerCredential *credential;
	char *record_bytes;
	size_t record_length;
} Owner;

struct Host {
	pthread_mutex_t gate;
	LockHolder holders[OE_MAX_OWNERS];
	bool failed;
	bool closing;
	bool closed;
	bool cleanup_registered;
	bool credential_claimed;
	int cgroup;
	uint64_t cgroup_device;
	uint64_t cgroup_inode;
	int storage;
	int tools;
	int bubblewrap;
	unsigned owner_limit;
	unsigned launch_limit;
	unsigned output_limit;
	unsigned operation_limit;
	unsigned journal_limit;
	unsigned close_timeout;
	unsigned process_timeout;
	unsigned argv_limit;
	unsigned record_limit;
	unsigned memory_limit;
	unsigned pids_limit;
	unsigned cpu_quota;
	unsigned cpu_period;
	unsigned disk_limit;
	unsigned inode_limit;
	unsigned root_count;
	unsigned artifact_count;
	SandboxPath roots[OE_MAX_ROOTS];
	SandboxPath artifacts[OE_MAX_ARTIFACTS];
	char tools_path[PATH_MAX];
	char storage_path[PATH_MAX];
	char cgroup_path[512];
	char unit[144];
	char invocation[40];
	char boot[40];
	char profile_digest[65];
	uint64_t last_lock_device;
	uint64_t last_lock_inode;
	uint64_t next_generation;
	Owner owners[OE_MAX_OWNERS];
};

static napi_value failure(napi_env env, const char *stage, int error) {
	char message[192];
	snprintf(message, sizeof(message), "%s: errno=%d", stage, error);
	napi_throw_error(env, stage, message);
	return NULL;
}

#define NAPI_CALL(env, expression) do { if ((expression) != napi_ok) return failure((env), "OWNER_NATIVE_ARGUMENT", EINVAL); } while (0)

static bool component(const char *name) {
	size_t n = strlen(name);
	if (n == 0 || n >= 192 || name[0] == '.') return false;
	for (size_t i = 0; i < n; i++) {
		char c = name[i];
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) return false;
	}
	return true;
}

static int duplicate_fd(int fd) { return fcntl(fd, F_DUPFD_CLOEXEC, 3); }

static int directory_fd(int fd, bool private_directory) {
	struct stat st;
	if (fstat(fd, &st) < 0) return -1;
	if (!S_ISDIR(st.st_mode) || (private_directory && (st.st_uid != getuid() || (st.st_mode & 0077)))) {
		errno = EPERM;
		return -1;
	}
	return duplicate_fd(fd);
}

static ssize_t read_small_at(int directory, const char *name, char *buffer, size_t capacity) {
	int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	size_t used = 0;
	while (used < capacity) {
		ssize_t n = read(fd, buffer + used, capacity - used);
		if (n < 0 && errno == EINTR) continue;
		if (n < 0) { int error = errno; close(fd); errno = error; return -1; }
		if (n == 0) break;
		used += (size_t)n;
	}
	int error = used == capacity ? EOVERFLOW : 0;
	close(fd);
	if (error) { errno = error; return -1; }
	buffer[used] = 0;
	return (ssize_t)used;
}

static int write_all(int fd, const unsigned char *data, size_t bytes) {
	while (bytes > 0) {
		ssize_t count = write(fd, data, bytes);
		if (count < 0 && errno == EINTR) continue;
		if (count <= 0) { if (count == 0) errno = EIO; return -1; }
		data += count;
		bytes -= (size_t)count;
	}
	return 0;
}

/* One bounded native control packet; the passed fd is duplicated by SCM_RIGHTS. */
static int send_lock_request(int socket, const LockRequest *request, int fd) {
	struct iovec iov = {(void *)request, sizeof(*request)};
	union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control;
	memset(&control, 0, sizeof(control));
	struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
	if (fd >= 0) {
		message.msg_control = control.bytes;
		message.msg_controllen = sizeof(control.bytes);
		struct cmsghdr *header = CMSG_FIRSTHDR(&message);
		header->cmsg_level = SOL_SOCKET;
		header->cmsg_type = SCM_RIGHTS;
		header->cmsg_len = CMSG_LEN(sizeof(int));
		memcpy(CMSG_DATA(header), &fd, sizeof(fd));
	}
	ssize_t n;
	do { n = sendmsg(socket, &message, MSG_NOSIGNAL | MSG_DONTWAIT); } while (n < 0 && errno == EINTR);
	if (n == (ssize_t)sizeof(*request)) return 0;
	if (n >= 0) errno = EIO;
	return -1;
}

static int receive_lock_request(int socket, LockRequest *request, int *fd) {
	struct iovec iov = {request, sizeof(*request)};
	union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control;
	struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1,
		.msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
	*fd = -1;
	ssize_t n;
	do { n = recvmsg(socket, &message, MSG_CMSG_CLOEXEC); } while (n < 0 && errno == EINTR);
	if (n == 0) return 0;
	struct cmsghdr *header = CMSG_FIRSTHDR(&message);
	if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS &&
		header->cmsg_len == CMSG_LEN(sizeof(int))) memcpy(fd, CMSG_DATA(header), sizeof(int));
	if (n != (ssize_t)sizeof(*request) || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC))) {
		if (*fd >= 0) close(*fd);
		*fd = -1;
		errno = EPROTO;
		return -1;
	}
	return 1;
}

static uint64_t clock_milliseconds(clockid_t clock);

static uint64_t close_deadline(unsigned timeout) {
	uint64_t now = clock_milliseconds(CLOCK_MONOTONIC);
	if (!now || now > (uint64_t)INT64_MAX - timeout) { errno = EOVERFLOW; return 0; }
	return now + timeout;
}

static int check_close_deadline(uint64_t deadline) {
	uint64_t now = clock_milliseconds(CLOCK_MONOTONIC);
	if (!now || !deadline || now >= deadline) { errno = ETIMEDOUT; return -1; }
	return 0;
}

static void fail_holder_channel(LockHolder *holder);

/* The reply and thread exit share one original deadline. A closed reply alone
 * does not prove the holder returned. On timeout its slot and references stay held. */
static int join_holder(LockHolder *holder, uint64_t deadline) {
	struct timespec until = {.tv_sec = (time_t)(deadline / 1000),
		.tv_nsec = (long)(deadline % 1000) * 1000000};
	int error = pthread_clockjoin_np(holder->thread, NULL, CLOCK_MONOTONIC, &until);
	if (error) { holder->failed = true; errno = error; return -1; }
	holder->started = false;
	int fd = holder->control;
	holder->control = -1; /* close is attempted once, even when its outcome is unknown. */
	if (close(fd) < 0) { holder->failed = true; return -1; }
	if (check_close_deadline(deadline) < 0) { holder->failed = true; return -1; }
	return 0;
}

static ssize_t receive_reply(int socket, LockReply *reply, uint64_t deadline) {
	struct timespec time;
	for (;;) {
		if (clock_gettime(CLOCK_MONOTONIC, &time) < 0) return -1;
		int64_t remaining = (int64_t)deadline - ((int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000);
		if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
		struct pollfd event = {.fd = socket, .events = POLLIN};
		int ready = poll(&event, 1, (int)remaining);
		if (ready < 0 && errno == EINTR) continue;
		if (ready <= 0) { if (!ready) errno = ETIMEDOUT; return -1; }
		ssize_t count = recv(socket, reply, sizeof(*reply), MSG_DONTWAIT | MSG_TRUNC);
		if (count < 0 && (errno == EAGAIN || errno == EINTR)) continue;
		return count;
	}
}

static int group_write(int directory, const char *name, const char *value);
static uint64_t clock_milliseconds(clockid_t clock);

/* The existing JA holder owns both kernel deadlines and the exact cgroup FD.
 * No JavaScript, host gate acquisition or new scheduler is needed to stop A. */
static void expire_held_owner(LockHolder *holder, int group, const int connections[OE_MAX_PROVIDER_SOCKETS]) {
	atomic_store(&holder->expired, true);
	for (unsigned i = 0; i < OE_MAX_PROVIDER_SOCKETS; i++) {
		if (connections[i] >= 0 && shutdown(connections[i], SHUT_RDWR) < 0 && errno != ENOTCONN) {
			atomic_store(&holder->expiry_failed, true);
		}
	}
	if (group >= 0) {
		// Keep the subtree frozen: a clone racing the last admission check must
		// not run even if it enters just after cgroup.kill completes.
		if (group_write(group, "cgroup.freeze", "1") < 0) atomic_store(&holder->expiry_failed, true);
		if (group_write(group, "cgroup.kill", "1") < 0) atomic_store(&holder->expiry_failed, true);
	}
}

static int close_held_expiry(int deadlines[2], int *group) {
	int error = 0;
	for (unsigned i = 0; i < 2; i++) {
		if (deadlines[i] >= 0 && close(deadlines[i]) < 0) error = errno;
		deadlines[i] = -1;
	}
	if (*group >= 0 && close(*group) < 0) error = errno;
	*group = -1;
	return error;
}

/* Called by H, never by the holder thread. A failed roundtrip must wake the
 * holder's stop path rather than leave A running until its original deadline.
 * Shutdown preserves descriptor custody; it does not release JA. */
static void fail_holder_channel(LockHolder *holder) {
	holder->failed = true;
	atomic_store(&holder->expired, true);
	atomic_store(&holder->expiry_failed, true);
	(void)shutdown(holder->control, SHUT_RDWR);
}

static void *hold_locks(void *data) {
	LockHolder *holder = data;
	int socket = holder->worker;
	int disabled;
	int setup_error = pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &disabled);
	sigset_t blocked;
	sigfillset(&blocked);
	int mask_error = pthread_sigmask(SIG_BLOCK, &blocked, NULL);
	LockSlot slots[OE_MAX_OWNERS];
	for (unsigned i = 0; i < OE_MAX_OWNERS; i++) slots[i] = (LockSlot){.fd = -1};
	LockReply ready = {.error = setup_error ? setup_error : mask_error};
	if (ready.error) {
		send(socket, &ready, sizeof(ready), MSG_NOSIGNAL);
		return NULL;
	}
	if (unshare(CLONE_FILES) < 0) {
		ready.error = errno;
		/* No close: until unshare succeeds this is still H's shared FD table. */
		send(socket, &ready, sizeof(ready), MSG_NOSIGNAL);
		return NULL;
	}
	if ((socket > 0 && syscall(SYS_close_range, 0U, (unsigned)socket - 1, 0U) < 0) ||
		syscall(SYS_close_range, (unsigned)socket + 1, UINT_MAX, 0U) < 0) {
		ready.error = errno;
		send(socket, &ready, sizeof(ready), MSG_NOSIGNAL);
		close(socket);
		return NULL;
	}
	if (send(socket, &ready, sizeof(ready), MSG_NOSIGNAL) != (ssize_t)sizeof(ready)) {
		close(socket);
		return NULL;
	}
	int deadlines[2] = {-1, -1}, group = -1;
	int connections[OE_MAX_PROVIDER_SOCKETS];
	for (unsigned i = 0; i < OE_MAX_PROVIDER_SOCKETS; i++) connections[i] = -1;
	uint64_t deadline_ms = 0, expires_ms = 0, last_wall_ms = 0;
	bool armed = false;
	for (;;) {
		struct pollfd events[3] = {{.fd = socket, .events = POLLIN},
			{.fd = deadlines[0], .events = POLLIN}, {.fd = deadlines[1], .events = POLLIN}};
		int available = poll(events, 3, -1);
		if (available < 0 && errno == EINTR) continue;
		if (available < 0) { atomic_store(&holder->expiry_failed, true); break; }
		if (events[1].revents || events[2].revents) {
			for (unsigned i = 0; i < 2; i++) if (events[i + 1].revents) {
				uint64_t expirations = 0;
				ssize_t count;
				do { count = read(deadlines[i], &expirations, sizeof(expirations)); } while (count < 0 && errno == EINTR);
				/* ECANCELED after a realtime clock change and malformed/error
				 * readiness are sticky failures, not normal expiry receipts. */
				if ((events[i + 1].revents & ~POLLIN) || count != (ssize_t)sizeof(expirations) || !expirations) {
					atomic_store(&holder->expiry_failed, true);
				}
			}
			expire_held_owner(holder, group, connections);
			for (unsigned i = 0; i < 2; i++) {
				if (deadlines[i] >= 0 && close(deadlines[i]) < 0) atomic_store(&holder->expiry_failed, true);
				deadlines[i] = -1;
			}
		}
		if (!events[0].revents) continue;
		LockRequest request;
		int directory;
		int received = receive_lock_request(socket, &request, &directory);
		if (received <= 0) break;
		LockReply reply = {.generation = request.generation};
		if (request.slot != holder->slot || request.slot >= OE_MAX_OWNERS) reply.error = EINVAL;
		else if (request.operation == 1) {
			LockSlot *slot = &slots[request.slot];
			request.name[sizeof(request.name) - 1] = 0;
			if (slot->fd >= 0 || directory < 0 || !component(request.name)) reply.error = EINVAL;
			else {
				int lock = openat(directory, request.name, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
				struct stat st;
				struct flock flock = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0};
				if (lock < 0) reply.error = errno;
				else if (fstat(lock, &st) < 0) reply.error = errno;
				else if (!S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 0077)) reply.error = EPERM;
				else if (fcntl(lock, F_OFD_SETLK, &flock) < 0) reply.error = errno;
				else if (fsync(lock) < 0 || fsync(directory) < 0) reply.error = errno;
				if (reply.error) { if (lock >= 0) close(lock); }
				else {
					*slot = (LockSlot){.fd = lock, .generation = request.generation};
					reply.device = (uint64_t)st.st_dev;
					reply.inode = (uint64_t)st.st_ino;
				}
			}
		} else if (request.operation == 2) {
			LockSlot *slot = &slots[request.slot];
			if (slot->fd < 0 || slot->generation != request.generation) reply.error = ESTALE;
			else {
				for (unsigned i = 0; i < OE_MAX_PROVIDER_SOCKETS; i++) if (connections[i] >= 0) reply.error = EBUSY;
				if (!reply.error) reply.error = close_held_expiry(deadlines, &group);
				if (!reply.error && ((request.cancelled && atomic_load(request.cancelled)) ||
					check_close_deadline(request.deadline_ms) < 0)) reply.error = ETIMEDOUT;
				if (!reply.error) {
					/* Original H explicitly admitted this irreversible exchange.
					 * Cancellation cannot undo an already admitted kernel close;
					 * a late/error reply remains UNKNOWN, never acknowledged retirement.
					 * On Linux close consumes the descriptor even on error. */
					if (close(slot->fd) < 0) reply.error = errno;
					slot->fd = -1;
				}
			}
		} else if (request.operation == 3) {
			LockSlot *slot = &slots[request.slot];
			if (armed || slot->fd < 0 || slot->generation != request.generation || directory >= 0 ||
				!request.deadline_ms || !request.expires_ms) reply.error = EINVAL;
			else {
				armed = true;
				deadline_ms = request.deadline_ms; expires_ms = request.expires_ms;
				last_wall_ms = clock_milliseconds(CLOCK_REALTIME);
				if (!last_wall_ms) reply.error = EIO;
				const clockid_t clocks[] = {CLOCK_MONOTONIC, CLOCK_REALTIME};
				const uint64_t times[] = {request.deadline_ms, request.expires_ms};
				for (unsigned i = 0; i < 2 && !reply.error; i++) {
					deadlines[i] = timerfd_create(clocks[i], TFD_CLOEXEC | TFD_NONBLOCK);
					struct itimerspec expiry = {.it_value = {.tv_sec = (time_t)(times[i] / 1000), .tv_nsec = (long)(times[i] % 1000) * 1000000}};
					if (deadlines[i] < 0 || timerfd_settime(deadlines[i], TFD_TIMER_ABSTIME | (i ? TFD_TIMER_CANCEL_ON_SET : 0), &expiry, NULL) < 0) reply.error = errno;
				}
				if (reply.error) { atomic_store(&holder->expiry_failed, true); expire_held_owner(holder, group, connections); }
			}
		} else if (request.operation == 4) {
			LockSlot *slot = &slots[request.slot];
			struct statfs fs;
			if (group >= 0 || directory < 0 || slot->fd < 0 || slot->generation != request.generation ||
				fstatfs(directory, &fs) < 0 || fs.f_type != CGROUP2_SUPER_MAGIC) reply.error = EINVAL;
			else {
				group = directory; directory = -1;
				if (atomic_load(&holder->expired)) { expire_held_owner(holder, group, connections); reply.error = ESTALE; }
			}
		} else if (request.operation == 5) {
			LockSlot *slot = &slots[request.slot];
			if (slot->fd < 0 || slot->generation != request.generation || directory >= 0) reply.error = EINVAL;
			else {
				for (unsigned i = 0; i < OE_MAX_PROVIDER_SOCKETS; i++) if (connections[i] >= 0) reply.error = EBUSY;
				if (!reply.error) reply.error = close_held_expiry(deadlines, &group);
				if (reply.error) atomic_store(&holder->expiry_failed, true);
				if (atomic_load(&holder->expiry_failed)) reply.error = ENOTRECOVERABLE;
			}
		} else if (request.operation == 6) {
			LockSlot *slot = &slots[request.slot];
			int type = 0;
			socklen_t length = sizeof(type);
			if (slot->fd < 0 || slot->generation != request.generation || directory < 0 || !armed ||
				request.connection >= OE_MAX_PROVIDER_SOCKETS || connections[request.connection] >= 0 ||
				getsockopt(directory, SOL_SOCKET, SO_TYPE, &type, &length) < 0 || type != SOCK_STREAM ||
				!((request.peer.ss_family == AF_INET && request.peer_length == sizeof(struct sockaddr_in)) ||
				  (request.peer.ss_family == AF_INET6 && request.peer_length == sizeof(struct sockaddr_in6)))) reply.error = EINVAL;
			else {
				connections[request.connection] = directory; directory = -1;
				uint64_t mono = clock_milliseconds(CLOCK_MONOTONIC), wall = clock_milliseconds(CLOCK_REALTIME);
				if (atomic_load(&holder->expired) || !mono || !wall || wall < last_wall_ms || mono >= deadline_ms || wall >= expires_ms) reply.error = ESTALE;
				else if (connect(connections[request.connection], (struct sockaddr *)&request.peer, request.peer_length) < 0 && errno != EINPROGRESS) reply.error = errno;
				mono = clock_milliseconds(CLOCK_MONOTONIC); wall = clock_milliseconds(CLOCK_REALTIME);
				if (!mono || !wall || wall < last_wall_ms || mono >= deadline_ms || wall >= expires_ms) reply.error = ESTALE;
				last_wall_ms = wall;
				if (reply.error) expire_held_owner(holder, group, connections);
			}
		} else if (request.operation == 7) {
			LockSlot *slot = &slots[request.slot];
			if (slot->fd < 0 || slot->generation != request.generation || directory >= 0 ||
				request.connection >= OE_MAX_PROVIDER_SOCKETS || connections[request.connection] < 0) reply.error = ESTALE;
			else {
				int fd = connections[request.connection];
				if (shutdown(fd, SHUT_RDWR) < 0 && errno != ENOTCONN) reply.error = errno;
				connections[request.connection] = -1;
				if (close(fd) < 0 && !reply.error) reply.error = errno;
			}
		} else if (request.operation == 8) {
			LockSlot *slot = &slots[request.slot];
			if (slot->fd < 0 || slot->generation != request.generation || directory >= 0) reply.error = ESTALE;
			else {
				expire_held_owner(holder, group, connections);
				if (atomic_load(&holder->expiry_failed)) reply.error = ENOTRECOVERABLE;
			}
		} else reply.error = EINVAL;
		if (directory >= 0) close(directory);
		bool finished = request.slot == holder->slot && slots[holder->slot].fd < 0;
		reply.closed = finished;
		ssize_t sent = send(socket, &reply, sizeof(reply), MSG_NOSIGNAL);
		if (finished) { close(socket); return NULL; }
		if (sent != (ssize_t)sizeof(reply)) break;
	}
	/* Channel loss stops A but is not orderly retirement. Keep JA until H dies. */
	atomic_store(&holder->expiry_failed, true);
	expire_held_owner(holder, group, connections);
	for (;;) pause();
}

static int start_holder(Host *host, unsigned slot) {
	LockHolder *holder = &host->holders[slot];
	if (holder->started || holder->failed) { errno = EBUSY; return -1; }
	uint64_t deadline = close_deadline(host->close_timeout);
	if (!deadline) return -1;
	int sockets[2];
	if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) < 0) return -1;
	struct timeval timeout = {.tv_sec = host->close_timeout / 1000, .tv_usec = (host->close_timeout % 1000) * 1000};
	if (setsockopt(sockets[0], SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
		setsockopt(sockets[0], SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) < 0) {
		int error = errno; close(sockets[0]); close(sockets[1]); errno = error; return -1;
	}
	*holder = (LockHolder){.control = sockets[0], .worker = sockets[1], .slot = slot};
	atomic_init(&holder->expired, false);
	atomic_init(&holder->expiry_failed, false);
	int error = pthread_create(&holder->thread, NULL, hold_locks, holder);
	if (error) { close(sockets[0]); close(sockets[1]); errno = error; return -1; }
	holder->started = true;
	LockReply ready;
	ssize_t count = receive_reply(holder->control, &ready, deadline);
	if (count != (ssize_t)sizeof(ready)) {
		// The worker might not have unshared yet. Do not close its shared-table
		// endpoint on an unknown start; only this bounded slot loses availability.
		fail_holder_channel(holder); errno = ETIMEDOUT; return -1;
	}
	close(holder->worker); holder->worker = -1;
	if (ready.error) {
		(void)join_holder(holder, deadline);
		errno = ready.error; return -1;
	}
	return 0;
}

static int holder_roundtrip(Host *host, const LockRequest *request, int directory) {
	unsigned operation = request->operation, slot = request->slot;
	uint64_t generation = request->generation;
	if (slot >= host->owner_limit) { errno = EINVAL; return -1; }
	LockHolder *holder = &host->holders[slot];
	if (holder->failed) { errno = EPIPE; return -1; }
	Owner *owner = &host->owners[slot];
	uint64_t deadline = owner->active && owner->generation == generation ? owner->close_deadline : 0;
	if (!deadline) deadline = close_deadline(host->close_timeout);
	if (check_close_deadline(deadline) < 0) { fail_holder_channel(holder); errno = ETIMEDOUT; return -1; }
	if (send_lock_request(holder->control, request, directory) < 0) {
		int error = errno; fail_holder_channel(holder); errno = error; return -1;
	}
	LockReply reply;
	ssize_t count = receive_reply(holder->control, &reply, deadline);
	if (count != (ssize_t)sizeof(reply) || reply.generation != generation) {
		int error = count < 0 ? errno : EPROTO;
		fail_holder_channel(holder);
		errno = error;
		return -1;
	}
	if (reply.closed && join_holder(holder, deadline) < 0) {
		if (reply.error) errno = reply.error; /* Preserve the original holder error. */
		return -1;
	}
	if (reply.error) { if (!reply.closed) fail_holder_channel(holder); errno = reply.error; return -1; }
	if (check_close_deadline(deadline) < 0) {
		if (!reply.closed) fail_holder_channel(holder);
		else holder->failed = true;
		errno = ETIMEDOUT;
		return -1;
	}
	if ((operation == 2) != reply.closed) {
		if (!reply.closed) fail_holder_channel(holder);
		else holder->failed = true;
		errno = EPROTO; return -1;
	}
	if (operation == 1) { host->last_lock_device = reply.device; host->last_lock_inode = reply.inode; }
	return 0;
}

static const atomic_bool *lifecycle_cancellation(const Owner *owner);

static int lock_roundtrip(Host *host, unsigned operation, unsigned slot, uint64_t generation,
	const char *name, int directory) {
	LockRequest request = {.operation = operation, .slot = slot, .generation = generation};
	if (operation == 2) {
		request.deadline_ms = host->owners[slot].close_deadline;
		request.cancelled = lifecycle_cancellation(&host->owners[slot]);
	}
	if (operation == 3) {
		request.deadline_ms = host->owners[slot].allocation_deadline;
		request.expires_ms = host->owners[slot].allocation.expires_ms;
	}
	if (name) snprintf(request.name, sizeof(request.name), "%s", name);
	return holder_roundtrip(host, &request, directory);
}

static bool get_u32(napi_env env, napi_value object, const char *name, unsigned *out) {
	napi_value value;
	double number;
	if (napi_get_named_property(env, object, name, &value) != napi_ok ||
		napi_get_value_double(env, value, &number) != napi_ok || number != number || number < 0 || number > UINT_MAX ||
		number != (unsigned)number) return false;
	*out = (unsigned)number;
	return true;
}

static bool get_string(napi_env env, napi_value value, char *out, size_t capacity) {
	size_t length;
	if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length >= capacity) return false;
	if (napi_get_value_string_utf8(env, value, out, capacity, &length) != napi_ok) return false;
	return strlen(out) == length;
}

static bool named_string(napi_env env, napi_value object, const char *name, char *out, size_t capacity) {
	napi_value value;
	return napi_get_named_property(env, object, name, &value) == napi_ok && get_string(env, value, out, capacity);
}

static Host *get_host(napi_env env, napi_value value) {
	bool tagged = false;
	void *pointer = NULL;
	if (napi_check_object_type_tag(env, value, &host_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return NULL;
	return pointer;
}

static int expected_directory(int fd, const char *expected);
static bool allocation_current(Owner *owner);

static bool owner_lock_matches(Host *host, Owner *owner) {
	struct stat lock;
	return expected_directory(owner->directory, host->storage_path) == 0 &&
		fstatat(owner->directory, owner->lock_name, &lock, AT_SYMLINK_NOFOLLOW) == 0 &&
		(uint64_t)lock.st_dev == owner->lock_device && (uint64_t)lock.st_ino == owner->lock_inode &&
		S_ISREG(lock.st_mode) && lock.st_nlink == 1 && lock.st_uid == getuid() && !(lock.st_mode & 0077);
}

static Owner *get_owner(napi_env env, napi_value value, LeaseRef **reference, bool terminal) {
	bool tagged = false;
	void *pointer = NULL;
	if (napi_check_object_type_tag(env, value, &lease_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return NULL;
	LeaseRef *ref = pointer;
	Host *host = ref->host;
	Owner *owner = &host->owners[ref->slot];
	if (owner->lifecycle || (host->failed && !terminal) || !owner->active || owner->release_started || owner->generation != ref->generation || (owner->uncertain && !terminal) ||
		(!terminal && (owner->sealed || owner->recovering || !allocation_current(owner)))) return NULL;
	if (!terminal && !owner_lock_matches(host, owner)) {
		owner->uncertain = owner->sealed = true;
		return NULL;
	}
	*reference = ref;
	return owner;
}

static int group_write(int directory, const char *name, const char *value);
static void close_sandbox(Host *host);

static bool cancel_pending_lifecycle(Owner *owner);

static void quarantine_owner(Owner *owner) {
	if (cancel_pending_lifecycle(owner)) return;
	owner->sealed = owner->uncertain = true;
	if (owner->provider_sockets) fail_holder_channel(owner->holder);
	if (owner->group >= 0) (void)group_write(owner->group, "cgroup.kill", "1");
}

static void cleanup_host(void *data) {
	Host *host = data;
	host->cleanup_registered = false;
	pthread_mutex_lock(&host->gate);
	host->closing = true;
	for (unsigned i = 0; i < host->owner_limit; i++) if (host->owners[i].active) quarantine_owner(&host->owners[i]);
	pthread_mutex_unlock(&host->gate);
}

static void close_host_files(Host *host) {
	if (host->closed) return;
	close(host->cgroup); close(host->storage); close(host->tools); close(host->bubblewrap); close_sandbox(host);
	host->closed = host->closing = true;
	atomic_store(&host_registered, false);
}

static void finalize_lease(napi_env env, void *data, void *hint) {
	(void)hint;
	LeaseRef *reference = data;
	/* Forgotten owners are stopped, not reported retired. */
	pthread_mutex_lock(&reference->host->gate);
	Owner *owner = &reference->host->owners[reference->slot];
	if (owner->active && owner->generation == reference->generation) quarantine_owner(owner);
	pthread_mutex_unlock(&reference->host->gate);
	napi_delete_reference(env, reference->host_ref);
	free(reference);
}

static void finalize_host(napi_env env, void *data, void *hint) {
	(void)hint;
	Host *host = data;
	pthread_mutex_lock(&host->gate);
	host->closing = true;
	bool retained = false;
	for (unsigned i = 0; i < host->owner_limit; i++) {
		if (host->owners[i].active) quarantine_owner(&host->owners[i]);
		retained |= host->owners[i].active || host->holders[i].started || host->holders[i].failed;
	}
	if (!retained) close_host_files(host);
	pthread_mutex_unlock(&host->gate);
	if (retained) return;
	if (host->cleanup_registered) napi_remove_env_cleanup_hook(env, cleanup_host, host);
	pthread_mutex_destroy(&host->gate);
	free(host);
}

static int expected_directory(int fd, const char *expected) {
	char link[64], actual[PATH_MAX];
	snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
	ssize_t n = readlink(link, actual, sizeof(actual) - 1);
	if (n < 0) return -1;
	actual[n] = 0;
	if (strcmp(expected, actual) != 0) { errno = ESTALE; return -1; }
	return 0;
}

static bool scalar_limit(int fd, const char *name, unsigned expected) {
	char bytes[64], *end;
	if (read_small_at(fd, name, bytes, sizeof(bytes) - 1) < 0) return false;
	errno = 0;
	unsigned long value = strtoul(bytes, &end, 10);
	return errno == 0 && end != bytes && (*end == '\n' || *end == 0) && value <= expected;
}

static bool hex_string(const char *text, size_t length);
static uint64_t mount_identity(int fd);
static int receive_sandbox(napi_env env, Host *host, napi_value profile, napi_value received);
static void close_sandbox(Host *host);
#include "host-validation.h"

static napi_value validate_host(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], expected, limits, storage, sandbox;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	if (argc != 2) return failure(env, "OWNER_HOST_ARGUMENT", EINVAL);
	NAPI_CALL(env, napi_get_named_property(env, args[0], "host", &expected));
	NAPI_CALL(env, napi_get_named_property(env, args[0], "limits", &limits));
	NAPI_CALL(env, napi_get_named_property(env, args[0], "storage", &storage));
	NAPI_CALL(env, napi_get_named_property(env, args[0], "sandbox", &sandbox));
	unsigned uid, gid, cgroup_fd, storage_fd, tool_fd, owner_limit, journal_limit, memory, pids, fds, launch_limit, output_limit, operation_limit, close_timeout, process_timeout, record_limit, argv_limit, cpu_quota, cpu_period, disk_limit, inode_limit;
	char cgroup_path[PATH_MAX], storage_path[PATH_MAX], tools_path[PATH_MAX], bubblewrap_path[PATH_MAX];
	napi_value artifacts, bubblewrap;
	NAPI_CALL(env, napi_get_named_property(env, args[0], "artifacts", &artifacts));
	NAPI_CALL(env, napi_get_named_property(env, artifacts, "bubblewrap", &bubblewrap));
	if (!get_u32(env, expected, "uid", &uid) || !get_u32(env, expected, "gid", &gid) ||
		!get_u32(env, args[1], "cgroupRoot", &cgroup_fd) || !get_u32(env, args[1], "storageRoot", &storage_fd) ||
		!get_u32(env, args[1], "toolRoot", &tool_fd) || !get_u32(env, limits, "owners", &owner_limit) ||
		!get_u32(env, limits, "memoryBytes", &memory) || !get_u32(env, limits, "pids", &pids) ||
		!get_u32(env, limits, "launchesPerOwner", &launch_limit) || !get_u32(env, limits, "outputBytes", &output_limit) ||
		!get_u32(env, limits, "operationsPerOwner", &operation_limit) ||
		!get_u32(env, limits, "closeTimeoutMs", &close_timeout) || !get_u32(env, limits, "processTimeoutMs", &process_timeout) ||
		!get_u32(env, limits, "recordBytes", &record_limit) ||
		!get_u32(env, limits, "argvBytes", &argv_limit) || !get_u32(env, limits, "cpuQuotaMicros", &cpu_quota) ||
		!get_u32(env, limits, "cpuPeriodMicros", &cpu_period) || !get_u32(env, limits, "diskBytes", &disk_limit) ||
		!get_u32(env, limits, "inodes", &inode_limit) ||
		!named_string(env, bubblewrap, "path", bubblewrap_path, sizeof(bubblewrap_path)) ||
		!get_u32(env, limits, "fileDescriptors", &fds) || !get_u32(env, storage, "journalBytes", &journal_limit) ||
		!named_string(env, expected, "cgroup", cgroup_path, sizeof(cgroup_path)) ||
		!named_string(env, storage, "root", storage_path, sizeof(storage_path)) ||
		!named_string(env, sandbox, "toolRoot", tools_path, sizeof(tools_path)) ||
		uid == 0 || uid != getuid() || uid != geteuid() || gid != getgid() || gid != getegid() ||
		owner_limit < 2 || owner_limit > OE_MAX_OWNERS || journal_limit > OE_MAX_JOURNAL || journal_limit < 1024 ||
		launch_limit < 1 || launch_limit > 64 || output_limit < 1024 || output_limit > OE_MAX_JOURNAL ||
		operation_limit < 1 || operation_limit > 1024 || close_timeout < 100 || close_timeout > 60000 ||
		process_timeout < 100 || process_timeout > 240000 ||
		record_limit < sizeof(OwnerRecord) || record_limit > OE_MAX_CONTROL || argv_limit < 1024 || argv_limit > OE_MAX_ARG_BYTES ||
		memory < 67108864U || memory > 2147483648U || pids < 4 || pids > 128 || fds < 32 || fds > 1024 ||
		cpu_period < 1000 || cpu_period > 1000000 || cpu_quota < 1000 || cpu_quota > cpu_period * 2 ||
		disk_limit < 1048576 || disk_limit > 268435456 || inode_limit < 16 || inode_limit > 4096 ||
		cgroup_fd > INT_MAX || storage_fd > INT_MAX || tool_fd > INT_MAX) return failure(env, "OWNER_HOST_PROFILE", EINVAL);
	if (host_privileges(uid, gid) < 0 || host_cgroup_mount((int)cgroup_fd) < 0 ||
		host_controllers((int)cgroup_fd, cpu_quota, cpu_period) < 0 || host_storage_limit((int)storage_fd, disk_limit, inode_limit) < 0) {
		return failure(env, "OWNER_HOST_OBSERVED_PROFILE", errno);
	}
	struct statfs fs;
	struct stat original_cgroup;
	if (fstat((int)cgroup_fd, &original_cgroup) < 0 || !S_ISDIR(original_cgroup.st_mode) ||
		fstatfs((int)cgroup_fd, &fs) < 0 || fs.f_type != CGROUP2_SUPER_MAGIC) return failure(env, "OWNER_HOST_CGROUP2", EPERM);
	char expected_cgroup[PATH_MAX];
	int expected_length = snprintf(expected_cgroup, sizeof(expected_cgroup), "/sys/fs/cgroup%s", cgroup_path);
	if (expected_length < 0 || (size_t)expected_length >= sizeof(expected_cgroup) ||
		expected_directory((int)cgroup_fd, expected_cgroup) < 0 ||
		expected_directory((int)storage_fd, storage_path) < 0 || expected_directory((int)tool_fd, tools_path) < 0) {
		return failure(env, "OWNER_HOST_DIRECTORY", errno);
	}
	char membership[PATH_MAX + 64], wanted[PATH_MAX + 64];
	if (read_small_at(AT_FDCWD, "/proc/self/cgroup", membership, sizeof(membership) - 1) < 0) return failure(env, "OWNER_HOST_MEMBERSHIP", errno);
	snprintf(wanted, sizeof(wanted), "0::%s/host\n", cgroup_path);
	if (strcmp(membership, wanted) != 0) return failure(env, "OWNER_HOST_MEMBERSHIP", EPERM);
	char type[64], processes[64];
	if (read_small_at((int)cgroup_fd, "cgroup.type", type, sizeof(type) - 1) < 0 || strcmp(type, "domain\n") != 0 ||
		read_small_at((int)cgroup_fd, "cgroup.procs", processes, sizeof(processes) - 1) != 0) return failure(env, "OWNER_HOST_TOPOLOGY", EPERM);
	struct rlimit nofile;
	if (!scalar_limit((int)cgroup_fd, "memory.max", memory) || !scalar_limit((int)cgroup_fd, "pids.max", pids) ||
		!scalar_limit((int)cgroup_fd, "memory.swap.max", 0) || getrlimit(RLIMIT_NOFILE, &nofile) < 0 ||
		nofile.rlim_cur > fds || nofile.rlim_max > fds) return failure(env, "OWNER_HOST_LIMIT", EPERM);
	/* Observed controls do not replace exact artifact/ABI/reaper qualification. */
	Host *host = calloc(1, sizeof(*host));
	if (!host) return failure(env, "OWNER_HOST_MEMORY", ENOMEM);
	const char *invocation = getenv("INVOCATION_ID");
	if (!invocation || !hex_string(invocation, 32) || strlen(cgroup_path) >= sizeof(host->cgroup_path) ||
		!named_string(env, expected, "unit", host->unit, sizeof(host->unit)) ||
		!named_string(env, args[1], "profileDigest", host->profile_digest, sizeof(host->profile_digest)) ||
		!hex_string(host->profile_digest, 64) ||
		read_small_at(AT_FDCWD, "/proc/sys/kernel/random/boot_id", host->boot, sizeof(host->boot) - 1) < 0) {
		free(host); return failure(env, "OWNER_HOST_IDENTITY", EINVAL);
	}
	host->boot[strcspn(host->boot, "\n")] = 0;
	if (strlen(host->boot) != 36) { free(host); return failure(env, "OWNER_HOST_BOOT", EPROTO); }
	snprintf(host->invocation, sizeof(host->invocation), "%s", invocation);
	snprintf(host->cgroup_path, sizeof(host->cgroup_path), "%s", cgroup_path);
	host->close_timeout = close_timeout; host->process_timeout = process_timeout; host->record_limit = record_limit; host->argv_limit = argv_limit;
	host->memory_limit = memory; host->pids_limit = pids; host->cpu_quota = cpu_quota; host->cpu_period = cpu_period;
	host->disk_limit = disk_limit; host->inode_limit = inode_limit;
	snprintf(host->tools_path, sizeof(host->tools_path), "%s", tools_path);
	snprintf(host->storage_path, sizeof(host->storage_path), "%s", storage_path);
	host->cgroup = directory_fd((int)cgroup_fd, false);
	host->cgroup_device = (uint64_t)original_cgroup.st_dev;
	host->cgroup_inode = (uint64_t)original_cgroup.st_ino;
	host->storage = directory_fd((int)storage_fd, true);
	host->tools = directory_fd((int)tool_fd, false);
	unsigned bubblewrap_fd;
	host->bubblewrap = get_u32(env, args[1], "bubblewrapFile", &bubblewrap_fd) && bubblewrap_fd <= INT_MAX ? duplicate_fd((int)bubblewrap_fd) : -1;
	struct stat executable;
	if (host->bubblewrap >= 0 && (fstat(host->bubblewrap, &executable) < 0 || !S_ISREG(executable.st_mode) ||
		executable.st_uid != 0 || executable.st_nlink != 1 || !(executable.st_mode & 0111) ||
		(executable.st_mode & (S_ISUID | S_ISGID | 0022)) || expected_directory(host->bubblewrap, bubblewrap_path) < 0)) {
		close(host->bubblewrap); host->bubblewrap = -1; errno = EPERM;
	}
	host->launch_limit = launch_limit;
	host->output_limit = output_limit;
	host->operation_limit = operation_limit;
	host->owner_limit = owner_limit;
	host->journal_limit = journal_limit;
	host->next_generation = 1;
	struct stat held_cgroup;
	if (host->cgroup < 0 || host->storage < 0 || host->tools < 0 || host->bubblewrap < 0 ||
		fstat(host->cgroup, &held_cgroup) < 0 || (uint64_t)held_cgroup.st_dev != host->cgroup_device ||
		(uint64_t)held_cgroup.st_ino != host->cgroup_inode || receive_sandbox(env, host, args[0], args[1]) < 0) {
		int error = errno;
		if (host->cgroup >= 0) close(host->cgroup);
		if (host->storage >= 0) close(host->storage);
		if (host->tools >= 0) close(host->tools);
		if (host->bubblewrap >= 0) close(host->bubblewrap);
		close_sandbox(host);
		free(host);
		return failure(env, "OWNER_HOST_DIRECTORY", error);
	}
	int gate_error = pthread_mutex_init(&host->gate, NULL);
	if (gate_error) {
		close(host->cgroup); close(host->storage); close(host->tools); close(host->bubblewrap); close_sandbox(host); free(host);
		return failure(env, "OWNER_HOST_GATE", gate_error);
	}
	bool registered = false;
	if (!atomic_compare_exchange_strong(&host_registered, &registered, true)) {
		close(host->cgroup); close(host->storage); close(host->tools); close(host->bubblewrap); close_sandbox(host);
		pthread_mutex_destroy(&host->gate); free(host);
		return failure(env, "OWNER_HOST_ALREADY_BOUND", EBUSY);
	}
	NAPI_CALL(env, napi_add_env_cleanup_hook(env, cleanup_host, host));
	host->cleanup_registered = true;
	napi_value result;
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, host, finalize_host, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &host_tag));
	return result;
}

static int publish_owner_record(Host *host, Owner *owner);
static int read_owner_record(Owner *owner, OwnerRecord *record);
static bool valid_owner_record(const OwnerRecord *record);

static uint64_t clock_milliseconds(clockid_t clock) {
	struct timespec now;
	if (clock_gettime(clock, &now) < 0 || now.tv_sec < 0) return 0;
	return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static bool allocation_current(Owner *owner) {
	if (!owner->holder || atomic_load(&owner->holder->expired) || atomic_load(&owner->holder->expiry_failed)) return false;
	if (!owner->allocation.id[0]) return true;
	uint64_t wall = clock_milliseconds(CLOCK_REALTIME), monotonic = clock_milliseconds(CLOCK_MONOTONIC);
	if (!wall || !monotonic || wall < owner->allocation.last_wall_ms) {
		fail_holder_channel(owner->holder);
		return false;
	}
	if (wall >= owner->allocation.expires_ms || monotonic >= owner->allocation_deadline) {
		atomic_store(&owner->holder->expired, true);
		return false;
	}
	owner->allocation.last_wall_ms = wall;
	return true;
}

static bool allocation_time(napi_env env, napi_value object, const char *name, uint64_t *out) {
	napi_value value;
	double number;
	if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_get_value_double(env, value, &number) != napi_ok ||
		number != number || number <= 0 || number > 9007199254740991.0 || number != (uint64_t)number) return false;
	*out = (uint64_t)number;
	return true;
}

/* Serialize claims across H processes using a short-lived native OFD mutex.
 * No JS runs while it is held. The only accounting remains in OwnerRecord. */
static int allocation_claim_lock(Host *host, Owner *owner, const OwnerAllocation *allocation) {
	int fd = openat(host->storage, "ordinary-allocation.lock", O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (fd < 0) return -1;
	struct stat st, named;
	struct flock lock = {.l_type = F_WRLCK, .l_whence = SEEK_SET};
	int error = 0;
	if (fstat(fd, &st) < 0 || fstatat(host->storage, "ordinary-allocation.lock", &named, AT_SYMLINK_NOFOLLOW) < 0) error = errno;
	else if (!S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 0077) ||
		st.st_dev != named.st_dev || st.st_ino != named.st_ino) error = EPERM;
	if (!error && fcntl(fd, F_OFD_SETLK, &lock) < 0) error = errno;
	int directory = error ? -1 : openat(host->storage, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (!error && directory < 0) error = errno;
	DIR *entries = directory < 0 ? NULL : fdopendir(directory);
	if (!error && !entries) { error = errno; close(directory); }
	if (entries) {
		unsigned count = 0;
		for (;;) {
			errno = 0;
			struct dirent *entry = readdir(entries);
			if (!entry) { if (errno) error = errno; break; }
			if (++count > host->inode_limit + 2) { error = EOVERFLOW; break; }
			size_t length = strlen(entry->d_name);
			if (length < 6 || strcmp(entry->d_name + length - 6, ".owner") || !strcmp(entry->d_name, owner->record_name)) continue;
			if (length >= sizeof(owner->record_name) || !component(entry->d_name)) { error = EPROTO; break; }
			Owner candidate = {.directory = host->storage};
			memcpy(candidate.record_name, entry->d_name, length + 1);
			OwnerRecord record;
			if (read_owner_record(&candidate, &record) < 0 || !valid_owner_record(&record)) { error = ESTALE; break; }
			if (record.allocation.id[0] && (!strcmp(record.allocation.id, allocation->id) ||
				!strcmp(record.allocation.instruction, allocation->instruction))) { error = EEXIST; break; }
		}
		if (closedir(entries) < 0 && !error) error = errno;
	}
	if (error) { close(fd); errno = error; return -1; }
	return fd;
}

/* Source bootstrap calls this before the private issuer. The allocation ID
 * selects an exclusion name, not a permission. The protected decision supplies
 * every permission and these finite numbers; the profile supplies neither. */
static napi_value claim_allocation(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 2 ? get_owner(env, args[0], &reference, false) : NULL;
	if (!owner) return failure(env, "OWNER_ALLOCATION_OWNER", ESTALE);
	OwnerAllocation received = {0};
	uint64_t not_before, expires;
	unsigned inference, automatic, count = 0;
	napi_value scope, count_value;
	napi_valuetype count_type;
	if (napi_get_named_property(env, args[1], "count", &count_value) != napi_ok ||
		napi_typeof(env, count_value, &count_type) != napi_ok ||
		(count_type != napi_undefined && !get_u32(env, args[1], "count", &count))) return failure(env, "OWNER_ALLOCATION_INPUT", EINVAL);
	bool scope_open;
	if (!named_string(env, args[1], "id", received.id, sizeof(received.id)) ||
		!named_string(env, args[1], "decision", received.decision, sizeof(received.decision)) ||
		!named_string(env, args[1], "instruction", received.instruction, sizeof(received.instruction)) ||
		!named_string(env, args[1], "principal", received.principal, sizeof(received.principal)) ||
		!allocation_time(env, args[1], "notBeforeMs", &not_before) || !allocation_time(env, args[1], "expiresMs", &expires) ||
		!get_u32(env, args[1], "inference", &inference) || !get_u32(env, args[1], "automatic", &automatic) ||
		napi_get_named_property(env, args[1], "scopeOpen", &scope) != napi_ok || napi_get_value_bool(env, scope, &scope_open) != napi_ok) {
		return failure(env, "OWNER_ALLOCATION_INPUT", EINVAL);
	}
	received.not_before_ms = not_before; received.expires_ms = expires;
	received.inference_limit = inference; received.count_limit = count; received.automatic_limit = automatic; received.automatic_stopped = !scope_open;
	Host *host = reference->host;
	pthread_mutex_lock(&host->gate);
	received.last_wall_ms = clock_milliseconds(CLOCK_REALTIME);
	uint64_t monotonic = clock_milliseconds(CLOCK_MONOTONIC);
	char expected[192];
	snprintf(expected, sizeof(expected), "allocation-%s.lock", received.id);
	bool current = oe_valid_allocation(&received) && monotonic && owner->active && owner->generation == reference->generation &&
		!owner->sealed && !owner->uncertain && !owner->recovering && !owner->release_started && !owner->admission && !owner->admitted &&
		!owner->allocation.id[0] && !owner->prior.allocation.id[0] && !strcmp(owner->lock_name, expected) && owner->journal_size &&
		!owner->operations && !owner->launch_count && !owner->mutation_flags && !host->failed && !host->closing && owner_lock_matches(host, owner);
	int error = current ? 0 : EPERM;
	int claim_lock = error ? -1 : allocation_claim_lock(host, owner, &received);
	if (!error && claim_lock < 0) error = errno;
	if (!error) {
		owner->allocation = received;
		owner->allocation_deadline = monotonic + received.expires_ms - received.last_wall_ms;
		if (!allocation_current(owner) || publish_owner_record(host, owner) < 0 ||
			lock_roundtrip(host, 3, reference->slot, reference->generation, NULL, -1) < 0 || !allocation_current(owner)) {
			error = errno ? errno : ESTALE; quarantine_owner(owner);
		}
	}
	if (claim_lock >= 0 && close(claim_lock) < 0) { if (!error) error = errno; quarantine_owner(owner); }
	pthread_mutex_unlock(&host->gate);
	if (error) return failure(env, "OWNER_ALLOCATION_CLAIM", error);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value automatic_turn(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	void *stop = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, &stop));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, stop != NULL) : NULL;
	if (!owner || !owner->allocation.id[0]) return failure(env, "OWNER_ALLOCATION_OWNER", ESTALE);
	pthread_mutex_lock(&reference->host->gate);
	int error = 0;
	if (owner->recovering || owner->uncertain || (!stop && (!owner->admitted || owner->sealed || !allocation_current(owner) ||
		owner->allocation.automatic_stopped || owner->allocation.automatic_spent >= owner->allocation.automatic_limit))) error = EPERM;
	if (!error) {
		if (stop) owner->allocation.automatic_stopped = 1;
		else owner->allocation.automatic_spent++;
		if (publish_owner_record(reference->host, owner) < 0) { error = errno; quarantine_owner(owner); }
	}
	pthread_mutex_unlock(&reference->host->gate);
	if (error) return failure(env, "OWNER_AUTOMATIC_ALLOCATION", error);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
	size_t argc = 5;
	napi_value args[5], result;
	bool existing;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	if (argc != 5 || napi_get_value_bool(env, args[3], &existing) != napi_ok) return failure(env, "OWNER_ACQUIRE_ARGUMENT", EINVAL);
	Host *host = get_host(env, args[0]);
	char name[192], journal_name[192], grant[65];
	if (!host || !get_string(env, args[1], name, sizeof(name)) || !component(name) ||
		!get_string(env, args[2], journal_name, sizeof(journal_name)) || !component(journal_name) ||
		!get_string(env, args[4], grant, sizeof(grant)) || !hex_string(grant, 64)) return failure(env, "OWNER_ACQUIRE_ARGUMENT", EINVAL);
	/* This initial recipe refuses restart/resume of any claimed operation. Its
	 * retained record is never converted into a fresh ticket or budget. */
	if (existing && !strncmp(name, "allocation-", 11)) return failure(env, "OWNER_ALLOCATION_REUSED", EPERM);
	LeaseRef *reference = calloc(1, sizeof(*reference));
	if (!reference) return failure(env, "OWNER_ACQUIRE_MEMORY", ENOMEM);
	pthread_mutex_lock(&host->gate);
	unsigned slot;
	for (slot = 0; slot < host->owner_limit && (host->owners[slot].active || host->holders[slot].failed); slot++) {}
	if (host->failed || host->closing || slot == host->owner_limit || host->next_generation == UINT64_MAX) {
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_ACQUIRE_UNAVAILABLE", EBUSY);
	}
	uint64_t generation = host->next_generation++;
	if (start_holder(host, slot) < 0 || lock_roundtrip(host, 1, slot, generation, name, host->storage) < 0) {
		int error = errno;
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_ACQUIRE_LOCK", error);
	}
	host->owners[slot] = (Owner){.active = true, .generation = generation, .directory = host->storage,
		.effects = -1, .group = -1, .holder = &host->holders[slot]};
	Owner *owner = &host->owners[slot];
	owner->lock_device = host->last_lock_device;
	owner->lock_inode = host->last_lock_inode;
	snprintf(owner->lock_name, sizeof(owner->lock_name), "%s", name);
	snprintf(owner->journal_name, sizeof(owner->journal_name), "%s", journal_name);
	snprintf(owner->grant, sizeof(owner->grant), "%s", grant);
	unsigned char random[16];
	if (getrandom(random, sizeof(random), 0) != (ssize_t)sizeof(random)) {
		owner->uncertain = owner->sealed = true;
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_INCARNATION", EIO);
	}
	memcpy(owner->group_name, "o-", 2);
	for (unsigned i = 0; i < sizeof(random); i++) snprintf(owner->group_name + 2 + 2 * i, 3, "%02x", random[i]);
	if (strlen(name) + sizeof(".owner") > sizeof(owner->record_name)) {
		owner->uncertain = owner->sealed = true;
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_RECORD_NAME", EINVAL);
	}
	snprintf(owner->record_name, sizeof(owner->record_name), "%s.owner", name);
	struct stat previous_record, storage_identity;
	int found = fstatat(owner->directory, owner->record_name, &previous_record, AT_SYMLINK_NOFOLLOW);
	int record_error = 0;
	if (found == 0) {
		if (!existing || read_owner_record(owner, &owner->prior) < 0 || !valid_owner_record(&owner->prior) ||
			fstat(owner->directory, &storage_identity) < 0 || strcmp(owner->prior.lock_name, name) ||
			strcmp(owner->prior.journal_name, journal_name) || owner->prior.lock_device != owner->lock_device ||
			owner->prior.lock_inode != owner->lock_inode || owner->prior.storage_device != (uint64_t)storage_identity.st_dev ||
			owner->prior.storage_inode != (uint64_t)storage_identity.st_ino || owner->prior.stop_generation == UINT64_MAX) record_error = ESTALE;
		else {
			owner->record_bytes = malloc(sizeof(owner->prior));
			if (!owner->record_bytes) record_error = ENOMEM;
			else {
				memcpy(owner->record_bytes, &owner->prior, sizeof(owner->prior)); owner->record_length = sizeof(owner->prior);
				owner->recovering = true; owner->journal_size = owner->prior.journal_size;
				owner->journal_device = owner->prior.journal_device; owner->journal_inode = owner->prior.journal_inode;
				owner->stop_generation = owner->prior.stop_generation + 1;
				owner->allocation = owner->prior.allocation;
			}
		}
	} else if (errno != ENOENT || existing) record_error = ENODATA;
	if (record_error) {
		owner->uncertain = owner->sealed = true;
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_RECORD_INVALID", record_error);
	}
	if (!owner->recovering && publish_owner_record(host, owner) < 0) {
		int error = errno;
		owner->uncertain = owner->sealed = true;
		pthread_mutex_unlock(&host->gate); free(reference);
		return failure(env, "OWNER_RECORD_UNCERTAIN", error);
	}
	*reference = (LeaseRef){.host = host, .slot = slot, .generation = generation};
	pthread_mutex_unlock(&host->gate);
	NAPI_CALL(env, napi_create_reference(env, args[0], 1, &reference->host_ref));
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, reference, finalize_lease, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &lease_tag));
	return result;
}

static int group_write(int directory, const char *name, const char *value);

static napi_value lifecycle_seal(napi_env env, napi_callback_info info);
static napi_value lifecycle_release(napi_env env, napi_callback_info info);

static napi_value seal(napi_env env, napi_callback_info info) {
	return lifecycle_seal(env, info);
}

static napi_value check(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	if (argc != 1 || !get_owner(env, value, &reference, false)) return failure(env, "STALE_OWNER", ESTALE);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static int lifecycle_journal_boundary(const Owner *owner);

/* Shared journal body: caller owns exclusive original-owner serialization.
 * No N-API, mutex or JSON encoding is performed here. */
static int commit_journal_bytes(Host *host, Owner *owner, const char *name,
	const unsigned char *previous, size_t previous_bytes, const unsigned char *next, size_t next_bytes,
	bool terminal_mode) {
	if (next_bytes > host->journal_limit || next_bytes < previous_bytes || next_bytes == 0 ||
		memcmp(previous, next, previous_bytes) != 0) return EINVAL;
	if ((owner->sealed && !terminal_mode) || owner->uncertain || host->failed ||
		(terminal_mode && (!owner->sealed || owner->launch_count != 0 || owner->operations != 0))) return ESTALE;
	if (strcmp(name, owner->journal_name) || previous_bytes != owner->journal_size) return ESTALE;
	int boundary = lifecycle_journal_boundary(owner);
	if (boundary) return boundary;
	unsigned char *snapshot = malloc(next_bytes);
	if (!snapshot) return ENOMEM;
	owner->mutation_flags |= OE_RECORD_WRITE_PENDING;
	if (publish_owner_record(host, owner) < 0) {
		owner->uncertain = owner->sealed = true;
		int error = errno;
		free(snapshot);
		return error;
	}
	boundary = lifecycle_journal_boundary(owner);
	if (boundary) { free(snapshot); return boundary; }
	int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW;
	if (previous_bytes == 0) flags |= O_CREAT | O_EXCL;
	int fd = openat(owner->directory, name, flags, 0600);
	int error = fd < 0 ? errno : 0;
	bool touched = false;
	struct stat st;
	if (!error && fstat(fd, &st) < 0) error = errno;
	if (!error && (!S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != getuid() ||
		(st.st_mode & 0077) || st.st_size != (off_t)previous_bytes ||
		(previous_bytes && ((uint64_t)st.st_dev != owner->journal_device || (uint64_t)st.st_ino != owner->journal_inode)))) error = ESTALE;
	if (!error && previous_bytes > 0) {
		size_t used = 0;
		while (used < previous_bytes) {
			if ((error = lifecycle_journal_boundary(owner))) break;
			ssize_t n = pread(fd, snapshot + used, previous_bytes - used, (off_t)used);
			if (n < 0 && errno == EINTR) continue;
			if (n <= 0) { error = n < 0 ? errno : EIO; break; }
			used += (size_t)n;
		}
		if (!error && memcmp(snapshot, previous, previous_bytes) != 0) error = ESTALE;
	}
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && lseek(fd, (off_t)previous_bytes, SEEK_SET) < 0) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error) {
		touched = true;
		if (write_all(fd, next + previous_bytes, next_bytes - previous_bytes) < 0) error = errno;
	}
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && fsync(fd) < 0) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error && fsync(owner->directory) < 0) error = errno;
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error) {
		size_t used = 0;
		while (used < next_bytes) {
			if ((error = lifecycle_journal_boundary(owner))) break;
			ssize_t n = pread(fd, snapshot + used, next_bytes - used, (off_t)used);
			if (n < 0 && errno == EINTR) continue;
			if (n <= 0) { error = n < 0 ? errno : EIO; break; }
			used += (size_t)n;
		}
		struct stat after, path_stat;
		if (!error && (fstat(fd, &after) < 0 || fstatat(owner->directory, name, &path_stat, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
		if (!error && (after.st_size != (off_t)next_bytes || after.st_dev != path_stat.st_dev ||
			after.st_ino != path_stat.st_ino || after.st_nlink != 1 || memcmp(snapshot, next, next_bytes) != 0)) error = ESTALE;
	}
	if (fd >= 0 && close(fd) < 0 && !error) error = errno;
	/* No unknown write is promoted merely because a reopened journal parses. */
	if (!error) error = lifecycle_journal_boundary(owner);
	if (!error) {
		owner->journal_size = next_bytes;
		owner->journal_device = (uint64_t)st.st_dev; owner->journal_inode = (uint64_t)st.st_ino;
		owner->mutation_flags &= ~OE_RECORD_WRITE_PENDING;
		if (publish_owner_record(host, owner) < 0) error = errno;
		if (!error) error = lifecycle_journal_boundary(owner);
	}
	if (error && (touched || previous_bytes == 0 || error == ESTALE || owner->record_bytes)) owner->uncertain = owner->sealed = true;
	free(snapshot);
	return error;
}

/* Existing synchronous append API remains durable; it does not acknowledge
 * speculative queued writes. Terminal callers use the private async entry. */
static napi_value commit_journal(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value args[4], result;
	void *terminal_mode = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, &terminal_mode));
	LeaseRef *reference;
	Owner *owner = argc == 4 ? get_owner(env, args[0], &reference, terminal_mode != NULL) : NULL;
	char name[192];
	void *previous, *next;
	size_t previous_bytes, next_bytes;
	if (!owner || !get_string(env, args[1], name, sizeof(name)) || !component(name) ||
		napi_get_buffer_info(env, args[2], &previous, &previous_bytes) != napi_ok ||
		napi_get_buffer_info(env, args[3], &next, &next_bytes) != napi_ok) return failure(env, "OWNER_COMMIT_ARGUMENT", EINVAL);
	pthread_mutex_lock(&reference->host->gate);
	int error = commit_journal_bytes(reference->host, owner, name, previous, previous_bytes, next, next_bytes, terminal_mode != NULL);
	pthread_mutex_unlock(&reference->host->gate);
	if (error) return failure(env, "OWNER_JOURNAL_UNCERTAIN", error);
	NAPI_CALL(env, napi_create_double(env, (double)next_bytes, &result));
	return result;
}

static napi_value read_journal(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 2 ? get_owner(env, args[0], &reference, false) : NULL;
	char name[192];
	if (!owner || !get_string(env, args[1], name, sizeof(name)) || !component(name)) return failure(env, "OWNER_READ_ARGUMENT", EINVAL);
	if (strcmp(name, owner->journal_name)) return failure(env, "OWNER_JOURNAL_SCOPE", ESTALE);
	int fd = openat(owner->directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0 && errno == ENOENT && owner->journal_size == 0) {
		NAPI_CALL(env, napi_create_buffer_copy(env, 0, "", NULL, &result)); return result;
	}
	if (fd < 0) return failure(env, "OWNER_READ_OPEN", errno);
	struct stat st;
	if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != getuid() ||
		(st.st_mode & 0077) || st.st_size <= 0 || st.st_size > reference->host->journal_limit ||
		(uint64_t)st.st_size != owner->journal_size || (uint64_t)st.st_dev != owner->journal_device || (uint64_t)st.st_ino != owner->journal_inode) {
		close(fd); return failure(env, "OWNER_READ_IDENTITY", EPERM);
	}
	size_t bytes = (size_t)st.st_size;
	unsigned char *buffer = malloc(bytes);
	if (!buffer) { close(fd); return failure(env, "OWNER_READ_MEMORY", ENOMEM); }
	size_t used = 0;
	int error = 0;
	while (used < bytes) {
		ssize_t n = pread(fd, buffer + used, bytes - used, (off_t)used);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) { error = n < 0 ? errno : EIO; break; }
		used += (size_t)n;
	}
	struct stat after, named;
	if (!error && (fstat(fd, &after) < 0 || fstatat(owner->directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
	if (!error && (after.st_size != st.st_size || after.st_ino != named.st_ino || after.st_dev != named.st_dev || after.st_nlink != 1)) error = ESTALE;
	close(fd);
	if (error) { free(buffer); owner->uncertain = owner->sealed = true; return failure(env, "OWNER_READ_UNCERTAIN", error); }
	napi_status status = napi_create_buffer_copy(env, bytes, buffer, NULL, &result);
	free(buffer);
	NAPI_CALL(env, status);
	return result;
}

static const napi_type_tag launch_tag = {0x5c522be42b19fa03ULL, 1};

struct Launch {
	Host *host;
	Owner *owner;
	uint64_t generation;
	Admission *admission;
	unsigned read_roots;
	unsigned write_roots;
	unsigned command;
	Launch *next;
	napi_ref lease_ref;
	napi_ref admission_ref;
	int executable;
	char name[32];
	int group;
	int mapping[OE_MAX_MAPPINGS];
	unsigned mapping_count;
	SandboxPath subroots[OE_MAX_ROOTS];
	unsigned subroot_count;
	char **argv;
	unsigned argc;
	size_t argument_bytes;
	int pipes[4][2];
	pid_t pid;
	int pidfd;
	bool dispatched;
	bool mutating;
	bool stopped;
	uint64_t sample_deadline;
	atomic_uint_fast64_t stop_deadline;
	atomic_bool stop_requested;
	bool exited;
	bool retired;
	bool eof[3];
	int exit_code;
	int signal;
	int error;
	size_t output_bytes;
};

static bool admission_root_allowed(const Launch *launch, unsigned root, bool writable);
static int admission_command(Launch *launch, const char *command);
static bool admission_launch_allowed(const Launch *launch);
#include "payload-seccomp.h"
#include "owner-sandbox.h"
#include "owner-admission.h"
#include "owner-credential.h"

static int group_write(int directory, const char *name, const char *value) {
	int fd = openat(directory, name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	int result = write_all(fd, (const unsigned char *)value, strlen(value));
	int error = errno;
	if (close(fd) < 0 && result == 0) return -1;
	errno = error;
	return result;
}

static int group_open(int parent, const char *name, bool existing_allowed) {
	if (mkdirat(parent, name, 0700) < 0 && (!existing_allowed || errno != EEXIST)) return -1;
	int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	struct statfs fs;
	if (fstatfs(fd, &fs) < 0 || fs.f_type != CGROUP2_SUPER_MAGIC) {
		close(fd); errno = EPERM; return -1;
	}
	return fd;
}

static int owner_group_limits(Host *host, int group) {
	char memory[32], pids[32], cpu[64], descendants[32];
	unsigned shares = host->owner_limit + 1;
	snprintf(memory, sizeof(memory), "%u", host->memory_limit / shares);
	snprintf(pids, sizeof(pids), "%u", host->pids_limit / shares ? host->pids_limit / shares : 1);
	unsigned quota = host->cpu_quota / shares;
	snprintf(cpu, sizeof(cpu), "%u %u", quota < 1000 ? 1000 : quota, host->cpu_period);
	snprintf(descendants, sizeof(descendants), "%u", host->launch_limit);
	const char *names[] = {"memory.max", "memory.swap.max", "memory.oom.group", "pids.max", "cpu.max", "cgroup.max.depth", "cgroup.max.descendants"};
	const char *values[] = {memory, "0", "1", pids, cpu, "1", descendants};
	for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
		char actual[128], expected[128];
		if (group_write(group, names[i], values[i]) < 0 || read_small_at(group, names[i], actual, sizeof(actual) - 1) < 0) return -1;
		snprintf(expected, sizeof(expected), "%s\n", values[i]);
		if (strcmp(actual, expected)) { errno = EIO; return -1; }
	}
	return 0;
}

static int group_empty(int group) {
	char events[256];
	if (read_small_at(group, "cgroup.events", events, sizeof(events) - 1) < 0) return -1;
	if (strstr(events, "populated 0\n")) return 1;
	if (strstr(events, "populated 1\n")) return 0;
	errno = EPROTO;
	return -1;
}

static uint64_t pid_start(pid_t pid) {
	char stat[4096], path[64];
	snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
	if (read_small_at(AT_FDCWD, path, stat, sizeof(stat) - 1) < 0) return 0;
	char *end = strrchr(stat, ')');
	if (!end) return 0;
	char *cursor = end + 1;
	for (unsigned field = 3; field <= 22; field++) {
		while (*cursor == ' ') cursor++;
		if (field == 22) return strtoull(cursor, NULL, 10);
		while (*cursor && *cursor != ' ') cursor++;
	}
	return 0;
}

static uint64_t mount_identity(int fd) {
	struct statx st;
	memset(&st, 0, sizeof(st));
	if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID, &st) < 0 ||
		!(st.stx_mask & STATX_MNT_ID)) return 0;
	return st.stx_mnt_id;
}

static bool hex_string(const char *text, size_t length) {
	if (strlen(text) != length) return false;
	for (size_t i = 0; i < length; i++) if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) return false;
	return true;
}

static bool record_string(const char *text, size_t capacity) {
	const char *end = memchr(text, 0, capacity);
	if (!end) return false;
	for (const char *p = end; p < text + capacity; p++) if (*p) return false;
	return true;
}

static int read_owner_record(Owner *owner, OwnerRecord *record) {
	int fd = openat(owner->directory, owner->record_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	struct stat before, after, named;
	int error = 0;
	if (fstat(fd, &before) < 0) error = errno;
	else if (!S_ISREG(before.st_mode) || before.st_uid != getuid() || before.st_nlink != 1 ||
		(before.st_mode & 0077) || before.st_size != (off_t)sizeof(*record)) error = EPROTO;
	size_t used = 0;
	while (!error && used < sizeof(*record)) {
		ssize_t n = pread(fd, (char *)record + used, sizeof(*record) - used, (off_t)used);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) { error = n < 0 ? errno : EIO; break; }
		used += (size_t)n;
	}
	if (!error && (fstat(fd, &after) < 0 || fstatat(owner->directory, owner->record_name, &named, AT_SYMLINK_NOFOLLOW) < 0)) error = errno;
	if (!error && (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size ||
		after.st_dev != named.st_dev || after.st_ino != named.st_ino || named.st_nlink != 1)) error = ESTALE;
	if (close(fd) < 0 && !error) error = errno;
	if (error) { errno = error; return -1; }
	return 0;
}

static bool valid_owner_record(const OwnerRecord *record) {
	if (memcmp(record->magic, "PIOWNER1", 8) || record->version != OE_RECORD_VERSION || record->bytes != sizeof(*record) ||
		!oe_valid_allocation(&record->allocation) ||
		record->disposition < OE_RECORD_ACTIVE || record->disposition > OE_RECORD_UNCERTAIN ||
		record->uncertainty > (OE_RECORD_WRITE_PENDING | OE_RECORD_LOCAL_PENDING | OE_RECORD_REMOTE_PENDING) || record->launch_count > 64 ||
		record->operations > 1024 || record->pid == 0 || record->pid > INT_MAX || !record->start_ticks || !record->root_mount) return false;
#define RECORD_STRING(field) if (!record_string(record->field, sizeof(record->field))) return false
	RECORD_STRING(boot); RECORD_STRING(invocation); RECORD_STRING(unit); RECORD_STRING(cgroup);
	RECORD_STRING(profile); RECORD_STRING(grant); RECORD_STRING(lock_name); RECORD_STRING(journal_name); RECORD_STRING(group);
#undef RECORD_STRING
	const char *unit = strrchr(record->cgroup, '/');
	if (!sandbox_path(record->cgroup) || !unit || strcmp(unit + 1, record->unit) ||
		strlen(record->boot) != 36 || !hex_string(record->invocation, 32) ||
		!hex_string(record->profile, 64) || !hex_string(record->grant, 64) || !component(record->lock_name) ||
		!component(record->journal_name) || strncmp(record->group, "o-", 2) || !hex_string(record->group + 2, 32)) return false;
	for (unsigned i = 0; i < 64; i++) {
		if (!record_string(record->launches[i], sizeof(record->launches[i]))) return false;
		if (i >= record->launch_count) { if (record->launches[i][0]) return false; }
		else {
			if (strncmp(record->launches[i], "l-", 2) || !component(record->launches[i])) return false;
			for (unsigned j = 0; j < i; j++) if (!strcmp(record->launches[i], record->launches[j])) return false;
		}
	}
	if (record->disposition == OE_RECORD_RETIRED && (record->operations || record->launch_count || record->uncertainty)) return false;
	return true;
}

/* One fixed native control record; it cannot encode transcript entries or mint
 * retirement from a caller flag. The terminal disposition is set only below the
 * native drain/removal checks. All snapshots are sync/readback fenced under JA. */
static int publish_owner_record(Host *host, Owner *owner) {
	if (owner->release_started || !owner_lock_matches(host, owner)) { errno = ESTALE; return -1; }
	if (owner->sequence == UINT_MAX) { errno = EOVERFLOW; return -1; }
	OwnerRecord record;
	memset(&record, 0, sizeof(record));
	struct stat root, storage;
	record.start_ticks = pid_start(getpid());
	record.root_mount = mount_identity(host->cgroup);
	if (!record.start_ticks || !record.root_mount || fstat(host->cgroup, &root) < 0 || fstat(owner->directory, &storage) < 0) return -1;
	memcpy(record.magic, "PIOWNER1", 8);
	record.version = OE_RECORD_VERSION; record.bytes = sizeof(record);
	record.allocation = owner->allocation;
	record.disposition = owner->uncertain ? OE_RECORD_UNCERTAIN : owner->retired ? OE_RECORD_RETIRED : owner->sealed ? OE_RECORD_DRAINING : OE_RECORD_ACTIVE;
	record.uncertainty = owner->mutation_flags;
	record.pid = (uint64_t)getpid(); record.root_device = (uint64_t)root.st_dev; record.root_inode = (uint64_t)root.st_ino;
	record.storage_device = (uint64_t)storage.st_dev; record.storage_inode = (uint64_t)storage.st_ino;
	record.lock_device = owner->lock_device; record.lock_inode = owner->lock_inode;
	record.stop_generation = owner->stop_generation; record.sequence = ++owner->sequence;
	record.journal_size = owner->journal_size; record.journal_device = owner->journal_device; record.journal_inode = owner->journal_inode;
	record.operations = owner->operations;
#define COPY_RECORD(field, source) snprintf(record.field, sizeof(record.field), "%s", source)
	COPY_RECORD(boot, host->boot); COPY_RECORD(invocation, host->invocation); COPY_RECORD(unit, host->unit);
	COPY_RECORD(cgroup, host->cgroup_path); COPY_RECORD(profile, host->profile_digest); COPY_RECORD(grant, owner->grant);
	COPY_RECORD(lock_name, owner->lock_name); COPY_RECORD(journal_name, owner->journal_name); COPY_RECORD(group, owner->group_name);
#undef COPY_RECORD
	for (Launch *launch = owner->launches; launch; launch = launch->next) {
		if (launch->retired) continue;
		if (record.launch_count == 64) { errno = EOVERFLOW; return -1; }
		snprintf(record.launches[record.launch_count++], sizeof(record.launches[0]), "%s", launch->name);
	}
	if (sizeof(record) > host->record_limit || !valid_owner_record(&record)) { errno = EPROTO; return -1; }
	char *copy = malloc(sizeof(record));
	if (!copy) return -1;
	memcpy(copy, &record, sizeof(record));
	if (owner->record_bytes) {
		OwnerRecord previous;
		if (read_owner_record(owner, &previous) < 0 || owner->record_length != sizeof(previous) || memcmp(&previous, owner->record_bytes, sizeof(previous))) {
			free(copy); errno = ESTALE; return -1;
		}
	}
	char temporary[192];
	snprintf(temporary, sizeof(temporary), "%s-%u.control", owner->group_name, owner->sequence);
	const char *name = owner->record_bytes ? temporary : owner->record_name;
	int fd = openat(owner->directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
	if (fd < 0) { free(copy); return -1; }
	int error = 0;
	if (write_all(fd, (const unsigned char *)&record, sizeof(record)) < 0 || fsync(fd) < 0) error = errno;
	if (close(fd) < 0 && !error) error = errno;
	if (!error && owner->record_bytes && renameat(owner->directory, temporary, owner->directory, owner->record_name) < 0) error = errno;
	if (!error && fsync(owner->directory) < 0) error = errno;
	OwnerRecord actual;
	if (!error && (read_owner_record(owner, &actual) < 0 || memcmp(&actual, &record, sizeof(actual)))) error = EIO;
	if (error) { free(copy); errno = error; return -1; }
	free(owner->record_bytes); owner->record_bytes = copy; owner->record_length = sizeof(record);
	return 0;
}

/* PID absence is not the normal retirement path. This is used only after JA
 * was acquired and for a non-terminal record whose producer may have crashed. */
static int producer_dead(const OwnerRecord *record) {
	int fd = (int)syscall(SYS_pidfd_open, (pid_t)record->pid, 0);
	if (fd < 0) return errno == ESRCH ? 1 : -1;
	uint64_t start = pid_start((pid_t)record->pid);
	struct pollfd event = {.fd = fd, .events = POLLIN};
	int ready = poll(&event, 1, 0);
	int error = errno;
	close(fd);
	if (ready < 0) { errno = error; return -1; }
	if (start && start != record->start_ticks) return 1;
	if (ready > 0 && (event.revents & POLLIN)) return 1;
	if (!start) { errno = EAGAIN; return -1; }
	return 0;
}

static napi_value recovery_status(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result, needed, path, invocation, terminal;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, true) : NULL;
	if (!owner) return failure(env, "STALE_OWNER", ESTALE);
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_get_boolean(env, owner->recovering, &needed));
	NAPI_CALL(env, napi_set_named_property(env, result, "needed", needed));
	NAPI_CALL(env, napi_create_string_utf8(env, owner->recovering ? owner->prior.cgroup : "", NAPI_AUTO_LENGTH, &path));
	NAPI_CALL(env, napi_set_named_property(env, result, "cgroup", path));
	NAPI_CALL(env, napi_create_string_utf8(env, owner->recovering ? owner->prior.invocation : "", NAPI_AUTO_LENGTH, &invocation));
	NAPI_CALL(env, napi_set_named_property(env, result, "invocation", invocation));
	NAPI_CALL(env, napi_get_boolean(env, owner->recovering && owner->prior.disposition == OE_RECORD_RETIRED, &terminal));
	NAPI_CALL(env, napi_set_named_property(env, result, "terminal", terminal));
	return result;
}

static napi_value recover_owner(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 2 ? get_owner(env, args[0], &reference, true) : NULL;
	int32_t root;
	if (!owner || !owner->recovering || owner->uncertain || napi_get_value_int32(env, args[1], &root) != napi_ok) return failure(env, "OWNER_RECOVERY_ARGUMENT", EINVAL);
	Host *host = reference->host;
	pthread_mutex_lock(&host->gate);
	OwnerRecord actual;
	int error = 0;
	bool drained = true;
	if (read_owner_record(owner, &actual) < 0 || memcmp(&actual, &owner->prior, sizeof(actual))) error = ESTALE;
	if (!error && owner->prior.disposition != OE_RECORD_RETIRED) {
		struct stat identity;
		struct statfs fs;
		char expected[PATH_MAX];
		snprintf(expected, sizeof(expected), "/sys/fs/cgroup%s", owner->prior.cgroup);
		if (strcmp(owner->prior.boot, host->boot) || root < 0 || fstat(root, &identity) < 0 ||
			fstatfs(root, &fs) < 0 || fs.f_type != CGROUP2_SUPER_MAGIC || expected_directory(root, expected) < 0 ||
			(uint64_t)identity.st_dev != owner->prior.root_device || (uint64_t)identity.st_ino != owner->prior.root_inode ||
			mount_identity(root) != owner->prior.root_mount) error = ESTALE;
		if (!error) {
			int dead = producer_dead(&owner->prior);
			if (dead != 1) error = dead == 0 ? EBUSY : errno;
		}
		int effects = -1, group = -1;
		if (!error) {
			effects = openat(root, "effects", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
			if (effects < 0 && errno != ENOENT) error = errno;
		}
		if (!error && effects >= 0) {
			group = openat(effects, owner->prior.group, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
			if (group < 0 && errno != ENOENT) error = errno;
		}
		if (!error && group >= 0) {
			if (group_write(group, "cgroup.kill", "1") < 0) error = errno;
			int empty = error ? -1 : group_empty(group);
			if (!error && empty < 0) error = errno;
			else if (!error && empty == 0) drained = false;
			if (!error && drained) {
				for (unsigned i = 0; i < owner->prior.launch_count; i++) {
					if (unlinkat(group, owner->prior.launches[i], AT_REMOVEDIR) < 0 && errno != ENOENT) { error = errno; break; }
				}
				// Unexpected names prevent rmdir and therefore prevent retirement.
				if (!error && unlinkat(effects, owner->prior.group, AT_REMOVEDIR) < 0) error = errno;
			}
		}
		if (group >= 0) close(group);
		if (effects >= 0) close(effects);
	}
	if (!error && drained) {
		if (owner->prior.uncertainty || owner->prior.disposition == OE_RECORD_UNCERTAIN) error = ENOTRECOVERABLE;
		else {
			owner->recovering = false;
			if (publish_owner_record(host, owner) < 0) { error = errno; owner->uncertain = owner->sealed = true; }
		}
	}
	pthread_mutex_unlock(&host->gate);
	if (error) return failure(env, "OWNER_RECOVERY_FENCED", error);
	NAPI_CALL(env, napi_get_boolean(env, drained, &result));
	return result;
}

static Launch *get_launch(napi_env env, napi_value value) {
	bool tagged = false;
	void *pointer = NULL;
	if (napi_check_object_type_tag(env, value, &launch_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return NULL;
	Launch *launch = pointer;
	if (launch->owner->lifecycle || !launch->owner->active || launch->owner->generation != launch->generation) return NULL;
	return launch;
}

static void close_launch_preparation(Launch *launch) {
	for (unsigned i = 0; i < launch->subroot_count; i++) {
		if (launch->subroots[i].fd >= 0) { close(launch->subroots[i].fd); launch->subroots[i].fd = -1; }
	}
	if (launch->executable >= 0) { close(launch->executable); launch->executable = -1; }
	for (unsigned i = 0; i < launch->mapping_count; i++) {
		if (launch->mapping[i] >= 0) { close(launch->mapping[i]); launch->mapping[i] = -1; }
	}
	for (unsigned i = 0; i < 4; i++) for (unsigned j = 0; j < 2; j++) {
		if (launch->pipes[i][j] >= 0) { close(launch->pipes[i][j]); launch->pipes[i][j] = -1; }
	}
}

static void finalize_launch(napi_env env, void *data, void *hint) {
	(void)hint;
	Launch *launch = data;
	/* Abandonment initiates stop but does not invent pipe/reaper settlement. */
	if (!launch->retired) {
		pthread_mutex_lock(&launch->host->gate);
		quarantine_owner(launch->owner);
		pthread_mutex_unlock(&launch->host->gate);
		return;
	}
	for (unsigned i = 0; i < launch->argc; i++) free(launch->argv[i]);
	free(launch->argv);
	napi_delete_reference(env, launch->lease_ref);
	napi_delete_reference(env, launch->admission_ref);
	free(launch);
}

static napi_value prepare_launch(napi_env env, napi_callback_info info) {
	uint64_t admitted_at = clock_milliseconds(CLOCK_MONOTONIC);
	size_t argc = 3;
	napi_value args[3], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 3 ? get_owner(env, args[0], &reference, false) : NULL;
	double timeout;
	if (!owner || !owner->admitted || napi_get_value_double(env, args[2], &timeout) != napi_ok ||
		timeout != timeout || timeout < 1 || timeout > reference->host->process_timeout || timeout != (unsigned)timeout ||
		!admitted_at || admitted_at > (uint64_t)INT64_MAX - (unsigned)timeout - reference->host->close_timeout)
		return failure(env, "OWNER_LAUNCH_ARGUMENT", EINVAL);
	Host *host = reference->host;
	Launch *launch = calloc(1, sizeof(*launch));
	if (!launch) return failure(env, "OWNER_LAUNCH_MEMORY", ENOMEM);
	launch->host = host; launch->owner = owner; launch->generation = reference->generation;
	launch->sample_deadline = admitted_at + (unsigned)timeout;
	atomic_init(&launch->stop_deadline, 0);
	atomic_init(&launch->stop_requested, false);
	launch->admission = owner->admission;
	launch->command = UINT_MAX;
	launch->group = launch->pidfd = launch->executable = -1; launch->mapping_count = 5;
	napi_value admission_value;
	NAPI_CALL(env, napi_get_reference_value(env, owner->admission_ref, &admission_value));
	NAPI_CALL(env, napi_create_reference(env, admission_value, 1, &launch->admission_ref));
	for (unsigned i = 0; i < OE_MAX_MAPPINGS; i++) launch->mapping[i] = -1;
	for (unsigned i = 0; i < 4; i++) launch->pipes[i][0] = launch->pipes[i][1] = -1;
	int filter = payload_filter();
	int error = filter < 0 ? errno : 0;
	for (unsigned i = 0; !error && i < 4; i++) if (pipe2(launch->pipes[i], O_CLOEXEC) < 0) error = errno;
	int sources[OE_MAX_MAPPINGS] = {launch->pipes[0][0], launch->pipes[1][1], launch->pipes[2][1], host->bubblewrap, launch->pipes[3][1]};
	if (!error && build_sandbox(env, launch, args[1], sources, filter) < 0) error = errno;
	for (unsigned i = 0; !error && i < launch->mapping_count; i++) {
		launch->mapping[i] = fcntl(sources[i], F_DUPFD_CLOEXEC, (int)launch->mapping_count);
		if (launch->mapping[i] < 0) error = errno;
	}
	if (filter >= 0) close(filter);
	if (launch->executable >= 0) { close(launch->executable); launch->executable = -1; }
	pthread_mutex_lock(&host->gate);
	if (!error && (!owner->active || owner->generation != reference->generation || !owner->admitted || owner->release_started ||
		owner->sealed || owner->uncertain || host->failed || host->closing || !admission_launch_allowed(launch) ||
		owner->launch_count >= host->launch_limit || owner->sequence >= UINT_MAX - 2)) error = EBUSY;
	if (!error) {
		snprintf(launch->name, sizeof(launch->name), "l-%u", ++owner->sequence);
		launch->next = owner->launches; owner->launches = launch; owner->launch_count++;
		if (launch->mutating) owner->mutating_launches++;
		owner->mutation_flags = oe_local_mutation_flags(owner->mutation_flags, owner->mutating_operations, owner->mutating_launches);
		if (publish_owner_record(host, owner) < 0) error = errno;
		if (!error && owner->effects < 0) {
			if (group_write(host->cgroup, "cgroup.subtree_control", "+cpu +memory +pids") < 0) error = errno;
			if (!error && (owner->effects = group_open(host->cgroup, "effects", true)) < 0) error = errno;
			if (!error && group_write(owner->effects, "cgroup.subtree_control", "+cpu +memory +pids") < 0) error = errno;
			if (!error && (owner->group = group_open(owner->effects, owner->group_name, false)) < 0) error = errno;
			if (!error && owner_group_limits(host, owner->group) < 0) error = errno;
			if (!error && group_write(owner->group, "cgroup.subtree_control", "+cpu +memory +pids") < 0) error = errno;
			if (!error && lock_roundtrip(host, 4, reference->slot, reference->generation, NULL, owner->group) < 0) error = errno;
		}
		if (!error && (launch->group = group_open(owner->group, launch->name, false)) < 0) error = errno;
		if (error) owner->uncertain = owner->sealed = true;
	}
	pthread_mutex_unlock(&host->gate);
	if (error) {
		close_launch_preparation(launch);
		/* A registered/published obligation stays owned even on preparation failure. */
		if (owner->launches != launch) {
			for (unsigned i = 0; i < launch->argc; i++) free(launch->argv[i]);
			napi_delete_reference(env, launch->admission_ref);
			free(launch->argv); free(launch);
		}
		return failure(env, "OWNER_LAUNCH_PREPARATION", error);
	}
	NAPI_CALL(env, napi_create_reference(env, args[0], 1, &launch->lease_ref));
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, launch, finalize_launch, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &launch_tag));
	return result;
}

__attribute__((noreturn, no_stack_protector)) static void child_error(int fd, int stage, long error) {
	int32_t record[2] = {stage, (int32_t)-error};
	oe_syscall6(__NR_write, fd, (long)record, sizeof(record), 0, 0, 0);
	oe_raw_exit(127);
}

__attribute__((noreturn, no_stack_protector)) static void child_exec(Launch *launch) {
	for (unsigned i = 0; i < launch->mapping_count; i++) {
		long result = oe_syscall6(__NR_dup3, launch->mapping[i], i, (i == 3 || i == 4) ? O_CLOEXEC : 0, 0, 0, 0);
		if (result < 0) child_error(launch->mapping[4], 1, result);
	}
	long closed = oe_syscall6(__NR_close_range, launch->mapping_count, UINT_MAX, 0, 0, 0, 0);
	if (closed < 0) child_error(4, 2, closed);
	struct { uint64_t handler, flags, restorer, mask; } action = {0, 0, 0, 0};
	for (unsigned signal = 1; signal <= 64; signal++) {
		if (signal == SIGKILL || signal == SIGSTOP) continue;
		long changed = oe_syscall6(__NR_rt_sigaction, signal, (long)&action, 0, 8, 0, 0);
		if (changed < 0) child_error(4, 3, changed);
	}
	uint64_t empty = 0;
	if (oe_syscall6(__NR_rt_sigprocmask, SIG_SETMASK, (long)&empty, 0, 8, 0, 0) < 0) child_error(4, 4, -EINVAL);
	if (oe_syscall6(__NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0) < 0) child_error(4, 5, -EPERM);
	char *environment[] = {"PATH=/nonexistent", "LANG=C", "LC_ALL=C", NULL};
	long executed = oe_syscall6(__NR_execveat, 3, (long)"", (long)launch->argv, (long)environment, AT_EMPTY_PATH, 0);
	child_error(4, 6, executed);
}

static napi_value dispatch_launch(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	Launch *launch = argc == 1 ? get_launch(env, value) : NULL;
	if (!launch || launch->dispatched || launch->stopped || launch->retired) return failure(env, "OWNER_LAUNCH_STATE", ESTALE);
	Host *host = launch->host;
	pthread_mutex_lock(&host->gate);
	if (!admission_launch_allowed(launch)) {
		quarantine_owner(launch->owner);
		pthread_mutex_unlock(&host->gate); return failure(env, "STALE_OWNER", ESTALE);
	}
	sigset_t all, previous;
	sigfillset(&all);
	int error = pthread_sigmask(SIG_SETMASK, &all, &previous);
	if (error) { pthread_mutex_unlock(&host->gate); return failure(env, "OWNER_LAUNCH_SIGNAL_MASK", error); }
	struct clone_args clone = {.flags = CLONE_INTO_CGROUP | CLONE_PIDFD,
		.pidfd = (uintptr_t)&launch->pidfd, .cgroup = (uint64_t)launch->group, .exit_signal = 0};
	long pid = oe_syscall6(__NR_clone3, (long)&clone, sizeof(clone), 0, 0, 0, 0);
	if (pid == 0) child_exec(launch);
	launch->dispatched = true;
	launch->pid = pid > 0 ? (pid_t)pid : -1;
	if (pid < 0) { launch->error = (int)-pid; launch->exited = true; }
	error = pthread_sigmask(SIG_SETMASK, &previous, NULL);
	if (error) { launch->owner->uncertain = launch->owner->sealed = true; launch->error = error; }
	/* Native custody is retained before returning any JavaScript acknowledgment. */
	for (unsigned i = 0; i < launch->mapping_count; i++) { close(launch->mapping[i]); launch->mapping[i] = -1; }
	close(launch->pipes[0][0]); launch->pipes[0][0] = -1;
	for (unsigned i = 1; i < 4; i++) { close(launch->pipes[i][1]); launch->pipes[i][1] = -1; }
	for (unsigned i = 0; i < 4; i++) {
		int fd = launch->pipes[i][i == 0 ? 1 : 0];
		int flags = fcntl(fd, F_GETFL);
		if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) { launch->error = errno; launch->owner->uncertain = launch->owner->sealed = true; }
	}
	pthread_mutex_unlock(&host->gate);
	NAPI_CALL(env, napi_create_int64(env, launch->pid, &result));
	return result;
}

static napi_value lifecycle_launch(napi_env env, napi_callback_info info, unsigned action);

static napi_value stop_launch(napi_env env, napi_callback_info info) {
	return lifecycle_launch(env, info, 4);
}

static napi_value poll_launch(napi_env env, napi_callback_info info) {
	return lifecycle_launch(env, info, 5);
}

static napi_value write_launch_stdin(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Launch *launch = argc == 2 ? get_launch(env, args[0]) : NULL;
	void *bytes;
	size_t size;
	if (!launch || !launch->dispatched || launch->retired || !admission_launch_allowed(launch) ||
		napi_get_buffer_info(env, args[1], &bytes, &size) != napi_ok || size > OE_MAX_ARG_BYTES) return failure(env, "OWNER_STDIN_STATE", EINVAL);
	ssize_t count = 0;
	if (size == 0) {
		if (launch->pipes[0][1] >= 0) close(launch->pipes[0][1]);
		launch->pipes[0][1] = -1;
	} else if (launch->pipes[0][1] < 0) return failure(env, "OWNER_STDIN_CLOSED", EPIPE);
	else {
		// Do not change H's process-wide SIGPIPE disposition or rely on Node/Bun
		// installing one. Consume only the signal generated by this failed write.
		sigset_t blocked, previous, pending;
		sigemptyset(&blocked); sigaddset(&blocked, SIGPIPE);
		int mask_error = pthread_sigmask(SIG_BLOCK, &blocked, &previous);
		if (mask_error) return failure(env, "OWNER_STDIN_SIGNAL_MASK", mask_error);
		sigpending(&pending);
		bool already_pending = sigismember(&pending, SIGPIPE) == 1;
		count = write(launch->pipes[0][1], bytes, size);
		int write_error = count < 0 ? errno : 0;
		if (write_error == EPIPE && !already_pending) {
			struct timespec immediate = {0, 0};
			while (sigtimedwait(&blocked, NULL, &immediate) < 0 && errno == EINTR) {}
		}
		mask_error = pthread_sigmask(SIG_SETMASK, &previous, NULL);
		if (mask_error) {
			launch->owner->uncertain = launch->owner->sealed = true;
			return failure(env, "OWNER_STDIN_SIGNAL_MASK", mask_error);
		}
		if (count < 0 && (write_error == EAGAIN || write_error == EINTR)) count = 0;
		if (count < 0) return failure(env, "OWNER_STDIN_WRITE", write_error);
	}
	NAPI_CALL(env, napi_create_int64(env, count, &result));
	return result;
}

static napi_value retire_launch(napi_env env, napi_callback_info info) {
	return lifecycle_launch(env, info, 6);
}

static const napi_type_tag operation_tag = {0x5c522be42b19fa04ULL, 1};
struct Operation {
	Host *host;
	Owner *owner;
	uint64_t generation;
	bool completed;
	bool completion_failed;
	uint64_t completion_deadline;
	uint64_t sample_deadline;
	Launch *launch;
	napi_ref launch_ref;
	bool mutating;
	bool dispatched;
	bool unknown;
	bool provider_socket;
	bool count_operation;
	char count_request_id[257];
	char count_body_hash[65];
	char inference_payload_hash[65];
	bool provider_transferred;
	bool provider_retired;
	int provider_fd;
	unsigned provider_slot;
	struct stat provider_identity;
	Admission *admission;
	unsigned kind;
	unsigned root;
	napi_ref lease_ref;
	napi_ref admission_ref;
};

static void finalize_operation(napi_env env, void *data, void *hint) {
	(void)hint;
	Operation *operation = data;
	/* An abandoned wrapper is not completion of its underlying I/O. */
	if (!operation->completed) {
		pthread_mutex_lock(&operation->host->gate);
		quarantine_owner(operation->owner);
		pthread_mutex_unlock(&operation->host->gate);
		return;
	}
	napi_delete_reference(env, operation->lease_ref);
	napi_delete_reference(env, operation->admission_ref);
	if (operation->launch_ref) napi_delete_reference(env, operation->launch_ref);
	free(operation);
}

static bool operation_allowed(const Operation *operation) {
	if (operation->owner->lifecycle) return false;
	Admission *admission = operation->admission;
	if (!admission_current(admission) || operation->generation != admission->generation ||
		!(admission->effects & operation->kind)) return false;
	if (operation->kind == OE_EFFECT_READ || operation->kind == OE_EFFECT_WRITE) {
		unsigned root = operation->root;
		if (root >= admission->host->root_count || !(admission->read_roots & (1U << root)) ||
			expected_directory(admission->host->roots[root].fd, admission->host->roots[root].path) < 0) return false;
		if (operation->kind == OE_EFFECT_WRITE && (!(admission->write_roots & (1U << root)) ||
			!admission->host->roots[root].writable)) return false;
	}
	return true;
}

static napi_value begin_operation(napi_env env, napi_callback_info info) {
	uint64_t admitted_at = clock_milliseconds(CLOCK_MONOTONIC);
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 2 ? get_owner(env, args[0], &reference, false) : NULL;
	if (!owner || !owner->admitted || !owner->admission) return failure(env, "STALE_OWNER", ESTALE);
	Operation *operation = calloc(1, sizeof(*operation));
	if (!operation) return failure(env, "OWNER_OPERATION_MEMORY", ENOMEM);
	*operation = (Operation){.host = reference->host, .owner = owner, .generation = reference->generation,
		.admission = owner->admission, .root = UINT_MAX, .provider_fd = -1};
	napi_value admission_value;
	NAPI_CALL(env, napi_get_reference_value(env, owner->admission_ref, &admission_value));
	NAPI_CALL(env, napi_create_reference(env, admission_value, 1, &operation->admission_ref));
	char kind[16];
	bool valid = named_string(env, args[1], "kind", kind, sizeof(kind));
	operation->kind = valid ? effect_kind(kind) : 0;
	if (operation->kind == OE_EFFECT_PROCESS) {
		unsigned timeout;
		valid = valid && get_u32(env, args[1], "timeoutMs", &timeout) && timeout &&
			timeout <= reference->host->process_timeout && admitted_at &&
			admitted_at <= (uint64_t)INT64_MAX - timeout - reference->host->close_timeout;
		if (valid) operation->sample_deadline = admitted_at + timeout;
	}
	operation->mutating = operation->kind == OE_EFFECT_WRITE;
	if (operation->kind == OE_EFFECT_READ || operation->mutating) valid &= get_u32(env, args[1], "root", &operation->root);
	if (operation->kind == OE_EFFECT_PROVIDER) {
		const char *names[] = {"provider", "model", "api", "baseUrl"};
		const char *expected[] = {operation->admission->provider, operation->admission->model,
			operation->admission->api, operation->admission->base_url};
		for (unsigned i = 0; valid && i < 4; i++) {
			char text[4096];
			valid = named_string(env, args[1], names[i], text, sizeof(text)) && !strcmp(text, expected[i]);
		}
		if (valid) {
			napi_value count_scope;
			napi_valuetype type;
			valid = napi_get_named_property(env, args[1], "count", &count_scope) == napi_ok && napi_typeof(env, count_scope, &type) == napi_ok;
			if (valid && type != napi_undefined) {
				operation->count_operation = true;
				const char *count_names[] = {"url", "method", "wireModel", "purpose", "account"};
				const char *count_expected[] = {operation->admission->count_url, "POST", operation->admission->count_model,
					operation->admission->count_purpose, operation->admission->count_account};
				valid = operation->admission->count_limit > 0;
				for (unsigned i = 0; valid && i < 5; i++) {
					char text[4096];
					valid = named_string(env, count_scope, count_names[i], text, sizeof(text)) && !strcmp(text, count_expected[i]);
				}
				valid = valid && named_string(env, count_scope, "requestId", operation->count_request_id, sizeof(operation->count_request_id)) && operation->count_request_id[0] &&
					named_string(env, count_scope, "countBodyHash", operation->count_body_hash, sizeof(operation->count_body_hash)) && hex_string(operation->count_body_hash, 64) &&
					named_string(env, count_scope, "payloadHash", operation->inference_payload_hash, sizeof(operation->inference_payload_hash)) && hex_string(operation->inference_payload_hash, 64);
			}
		}
	}
	pthread_mutex_lock(&reference->host->gate);
	Admission *admission = operation->admission;
	unsigned *reserved = operation->count_operation ? &admission->count_reserved : &admission->provider_reserved;
	unsigned spent = operation->count_operation ? admission->count_spent : admission->provider_spent;
	unsigned limit = operation->count_operation ? admission->count_limit : admission->provider_limit;
	if (!valid || !operation_allowed(operation) || owner->operations >= reference->host->operation_limit ||
		(operation->kind == OE_EFFECT_PROVIDER && *reserved + spent >= limit)) {
		pthread_mutex_unlock(&reference->host->gate);
		napi_delete_reference(env, operation->admission_ref); free(operation);
		return failure(env, "OWNER_OPERATION_UNAVAILABLE", EPERM);
	}
	owner->operations++;
	if (operation->mutating) owner->mutating_operations++;
	if (operation->kind == OE_EFFECT_PROVIDER) (*reserved)++;
	owner->mutation_flags = oe_local_mutation_flags(owner->mutation_flags, owner->mutating_operations, owner->mutating_launches);
	if (publish_owner_record(reference->host, owner) < 0) {
		int error = errno; quarantine_owner(owner);
		pthread_mutex_unlock(&reference->host->gate);
		napi_delete_reference(env, operation->admission_ref); free(operation);
		return failure(env, "OWNER_OPERATION_INTENT", error);
	}
	pthread_mutex_unlock(&reference->host->gate);
	NAPI_CALL(env, napi_create_reference(env, args[0], 1, &operation->lease_ref));
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, operation, finalize_operation, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &operation_tag));
	return result;
}

static napi_value check_operation(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	bool tagged = false;
	void *pointer = NULL;
	if (argc != 1 || napi_check_object_type_tag(env, value, &operation_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return failure(env, "OWNER_OPERATION_HANDLE", EINVAL);
	Operation *operation = pointer;
	if (operation->owner->lifecycle) return failure(env, "OWNER_LIFECYCLE_BUSY", EBUSY);
	pthread_mutex_lock(&operation->host->gate);
	int error = 0;
	if (operation->completed || !operation_allowed(operation) ||
		(operation->kind == OE_EFFECT_PROVIDER && operation->dispatched)) error = ESTALE;
	if (!error && operation->kind == OE_EFFECT_PROVIDER) {
		unsigned *reserved = operation->count_operation ? &operation->admission->count_reserved : &operation->admission->provider_reserved;
		if (!*reserved) error = EPROTO;
		else {
			(*reserved)--;
			if (operation->count_operation) {
				operation->admission->count_spent++;
				operation->owner->allocation.count_spent++;
			} else {
				operation->admission->provider_spent++;
				if (operation->owner->allocation.id[0]) operation->owner->allocation.inference_spent++;
			}
			operation->owner->remote_operations++;
			operation->owner->mutation_flags |= OE_RECORD_REMOTE_PENDING;
			operation->dispatched = true;
			if (publish_owner_record(operation->host, operation->owner) < 0) { error = errno; quarantine_owner(operation->owner); }
		}
	}
	/* Durable provider intent can block past expiry. Do not return a positive
	 * dispatch check from the permission observed before that write. */
	if (!error && !operation_allowed(operation)) { error = ESTALE; quarantine_owner(operation->owner); }
	if (!error) operation->dispatched = true;
	pthread_mutex_unlock(&operation->host->gate);
	if (error) return failure(env, "OWNER_OPERATION_DISPATCH", error);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

#include "owner-provider.h"
#include "owner-files.h"
#include "owner-trees.h"

static napi_value lifecycle_operation(napi_env env, napi_callback_info info);

static napi_value complete_operation(napi_env env, napi_callback_info info) {
	return lifecycle_operation(env, info);
}

static napi_value release_owner(napi_env env, napi_callback_info info) {
	return lifecycle_release(env, info);
}

static napi_value close_host(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	Host *host = argc == 1 ? get_host(env, value) : NULL;
	if (!host) return failure(env, "OWNER_HOST_ARGUMENT", EINVAL);
	pthread_mutex_lock(&host->gate);
	for (unsigned i = 0; i < host->owner_limit; i++) {
		if (host->owners[i].active || host->holders[i].started || host->holders[i].failed) {
			pthread_mutex_unlock(&host->gate); return failure(env, "OWNER_HOST_HAS_CUSTODY", EBUSY);
		}
	}
	close_host_files(host);
	pthread_mutex_unlock(&host->gate);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

#include "owner-lifecycle.h"
#include "owner-resources.h"

/* Observation of the original activation/allocation, never a spend/reservation.
 * Existing expiry and stale-lock checks retain their fail-closed latches. The
 * protected caller must test these remaining limits for its selected operation;
 * exhausted future work does not invalidate evidence of already completed work. */
static napi_value inspect_permission(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, false) : NULL;
	if (!owner) return failure(env, "OWNER_CURRENT_PERMISSION", ESTALE);
	Host *host = reference->host;
	uint64_t remaining[8];
	pthread_mutex_lock(&host->gate);
	Admission *admission = owner->admission;
	bool current = admission && owner->allocation.id[0] && admission_current(admission) &&
		!owner->allocation.automatic_stopped &&
		owner->allocation.inference_spent == admission->provider_spent &&
		owner->allocation.count_spent == admission->count_spent &&
		owner->allocation.automatic_spent <= owner->allocation.automatic_limit &&
		admission->provider_spent <= admission->provider_limit &&
		admission->provider_reserved <= admission->provider_limit - admission->provider_spent &&
		admission->count_spent <= admission->count_limit &&
		admission->count_reserved <= admission->count_limit - admission->count_spent &&
		owner->operations <= host->operation_limit && owner->launch_count <= host->launch_limit;
	uint64_t monotonic = clock_milliseconds(CLOCK_MONOTONIC);
	current = current && monotonic && monotonic < owner->allocation_deadline;
	if (current) {
		remaining[0] = owner->allocation.automatic_limit - owner->allocation.automatic_spent;
		remaining[1] = admission->provider_limit - admission->provider_spent - admission->provider_reserved;
		remaining[2] = admission->count_limit - admission->count_spent - admission->count_reserved;
		remaining[3] = host->operation_limit - owner->operations;
		remaining[4] = host->launch_limit - owner->launch_count;
		remaining[5] = owner->allocation.last_wall_ms;
		remaining[6] = owner->allocation.expires_ms;
		uint64_t wall_left = remaining[6] - remaining[5], mono_left = owner->allocation_deadline - monotonic;
		remaining[7] = wall_left < mono_left ? wall_left : mono_left;
	}
	pthread_mutex_unlock(&host->gate);
	if (!current) return failure(env, "OWNER_CURRENT_PERMISSION", EPERM);
	NAPI_CALL(env, napi_create_object(env, &result));
	const char *names[] = {"automaticRemaining", "inferenceRemaining", "countRemaining", "operationRemaining", "launchRemaining",
		"currentWallMs", "grantExpiresWallMs", "remainingMs"};
	for (unsigned i = 0; i < 8; i++) {
		napi_value number;
		NAPI_CALL(env, napi_create_double(env, (double)remaining[i], &number));
		napi_property_descriptor property = {.utf8name = names[i], .value = number, .attributes = napi_enumerable};
		NAPI_CALL(env, napi_define_properties(env, result, 1, &property));
	}
	return result;
}

#include "owner-clock.h"

static napi_value init(napi_env env, napi_value exports) {
	const napi_property_descriptor properties[] = {
		{"readClockSample", NULL, read_clock_sample, NULL, NULL, NULL, napi_default, NULL},
		{"validateHost", NULL, validate_host, NULL, NULL, NULL, napi_default, NULL},
		{"closeHost", NULL, close_host, NULL, NULL, NULL, napi_default, NULL},
		{"inspectResources", NULL, inspect_resources, NULL, NULL, NULL, napi_default, NULL},
		{"inspectPermission", NULL, inspect_permission, NULL, NULL, NULL, napi_default, NULL},
		{"acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL},
		{"recoveryStatus", NULL, recovery_status, NULL, NULL, NULL, napi_default, NULL},
		{"recoverOwner", NULL, recover_owner, NULL, NULL, NULL, napi_default, NULL},
		{"issueAdmission", NULL, issue_admission, NULL, NULL, NULL, napi_default, NULL},
		{"activateOwner", NULL, activate_owner, NULL, NULL, NULL, napi_default, NULL},
		{"claimAllocation", NULL, claim_allocation, NULL, NULL, NULL, napi_default, NULL},
		{"spendAutomaticTurn", NULL, automatic_turn, NULL, NULL, NULL, napi_default, NULL},
		{"stopAutomaticTurns", NULL, automatic_turn, NULL, NULL, NULL, napi_default, (void *)1},
		{"receiveCredential", NULL, receive_credential, NULL, NULL, NULL, napi_default, NULL},
		{"checkCredential", NULL, check_credential, NULL, NULL, NULL, napi_default, NULL},
		{"check", NULL, check, NULL, NULL, NULL, napi_default, NULL},
		{"seal", NULL, seal, NULL, NULL, NULL, napi_default, NULL},
		{"quarantine", NULL, seal, NULL, NULL, NULL, napi_default, (void *)1},
		{"cancelLifecycle", NULL, seal, NULL, NULL, NULL, napi_default, (void *)2},
		{"beginClose", NULL, seal, NULL, NULL, NULL, napi_default, (void *)3},
		{"readJournal", NULL, read_journal, NULL, NULL, NULL, napi_default, NULL},
		{"commitJournal", NULL, commit_journal, NULL, NULL, NULL, napi_default, NULL},
		{"prepareLaunch", NULL, prepare_launch, NULL, NULL, NULL, napi_default, NULL},
		{"dispatchLaunch", NULL, dispatch_launch, NULL, NULL, NULL, napi_default, NULL},
		{"stopLaunch", NULL, stop_launch, NULL, NULL, NULL, napi_default, NULL},
		{"requestStopLaunch", NULL, request_stop_launch, NULL, NULL, NULL, napi_default, NULL},
		{"pollLaunch", NULL, poll_launch, NULL, NULL, NULL, napi_default, NULL},
		{"writeLaunchStdin", NULL, write_launch_stdin, NULL, NULL, NULL, napi_default, NULL},
		{"retireLaunch", NULL, retire_launch, NULL, NULL, NULL, napi_default, NULL},
		{"beginOperation", NULL, begin_operation, NULL, NULL, NULL, napi_default, NULL},
		{"checkOperation", NULL, check_operation, NULL, NULL, NULL, napi_default, NULL},
		{"connectProvider", NULL, connect_provider, NULL, NULL, NULL, napi_default, NULL},
		{"takeProviderSocket", NULL, take_provider_socket, NULL, NULL, NULL, napi_default, NULL},
		{"retireProvider", NULL, retire_provider, NULL, NULL, NULL, napi_default, NULL},
		{"readFile", NULL, read_file, NULL, NULL, NULL, napi_default, NULL},
		{"writeFile", NULL, write_file, NULL, NULL, NULL, napi_default, NULL},
		{"listDirectories", NULL, list_directories, NULL, NULL, NULL, napi_default, NULL},
		{"readTree", NULL, read_tree, NULL, NULL, NULL, napi_default, NULL},
		{"createSnapshot", NULL, create_snapshot, NULL, NULL, NULL, napi_default, NULL},
		{"removeSnapshot", NULL, remove_snapshot, NULL, NULL, NULL, napi_default, NULL},
		{"completeOperation", NULL, complete_operation, NULL, NULL, NULL, napi_default, NULL},
		{"associateLaunch", NULL, associate_launch, NULL, NULL, NULL, napi_default, NULL},
		{"commitTerminalJournal", NULL, commit_journal, NULL, NULL, NULL, napi_default, (void *)1},
		{"commitTerminalJournalAsync", NULL, lifecycle_journal, NULL, NULL, NULL, napi_default, NULL},
		{"releaseOwner", NULL, release_owner, NULL, NULL, NULL, napi_default, NULL},
	};
	NAPI_CALL(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
	napi_value abi;
	NAPI_CALL(env, napi_create_uint32(env, 3, &abi));
	NAPI_CALL(env, napi_set_named_property(env, exports, "abi", abi));
	NAPI_CALL(env, napi_create_uint32(env, 1, &abi));
	NAPI_CALL(env, napi_set_named_property(env, exports, "clockAbi", abi));
	NAPI_CALL(env, napi_set_named_property(env, exports, "resourceAbi", abi));
	NAPI_CALL(env, napi_set_named_property(env, exports, "permissionAbi", abi));
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
