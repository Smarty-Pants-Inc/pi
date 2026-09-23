#ifndef PI_OWNER_PAYLOAD_SECCOMP_H
#define PI_OWNER_PAYLOAD_SECCOMP_H

#include <stddef.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/memfd.h>
#include <linux/seccomp.h>

#if defined(__x86_64__)
#define OE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define OE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unqualified payload architecture"
#endif

#define OE_DENY_SYSCALL(number) \
	BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
	BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

/* Applied by bubblewrap after namespace/mount setup, never to H. clone3 gets
 * ENOSYS so maintained libc can use ordinary clone for threads. Namespace clone
 * flags and alternate ABIs remain denied. io_uring must not bypass this filter. */
static int payload_filter(void) {
	const struct sock_filter filter[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, OE_AUDIT_ARCH, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
			CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET |
			CLONE_NEWPID | CLONE_NEWUTS | CLONE_PTRACE | 0x80U, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		OE_DENY_SYSCALL(__NR_socket),
		OE_DENY_SYSCALL(__NR_connect),
		OE_DENY_SYSCALL(__NR_setns),
		OE_DENY_SYSCALL(__NR_unshare),
		OE_DENY_SYSCALL(__NR_ptrace),
		OE_DENY_SYSCALL(__NR_process_vm_readv),
		OE_DENY_SYSCALL(__NR_process_vm_writev),
		OE_DENY_SYSCALL(__NR_pidfd_getfd),
		OE_DENY_SYSCALL(__NR_mount),
		OE_DENY_SYSCALL(__NR_umount2),
		OE_DENY_SYSCALL(__NR_pivot_root),
		OE_DENY_SYSCALL(__NR_fsopen),
		OE_DENY_SYSCALL(__NR_fsconfig),
		OE_DENY_SYSCALL(__NR_fsmount),
		OE_DENY_SYSCALL(__NR_move_mount),
		OE_DENY_SYSCALL(__NR_open_tree),
		OE_DENY_SYSCALL(__NR_mount_setattr),
		OE_DENY_SYSCALL(__NR_open_by_handle_at),
		OE_DENY_SYSCALL(__NR_name_to_handle_at),
		OE_DENY_SYSCALL(__NR_bpf),
		OE_DENY_SYSCALL(__NR_perf_event_open),
		OE_DENY_SYSCALL(__NR_userfaultfd),
		OE_DENY_SYSCALL(__NR_io_uring_setup),
		OE_DENY_SYSCALL(__NR_io_uring_register),
		OE_DENY_SYSCALL(__NR_io_uring_enter),
		OE_DENY_SYSCALL(__NR_keyctl),
		OE_DENY_SYSCALL(__NR_add_key),
		OE_DENY_SYSCALL(__NR_request_key),
		OE_DENY_SYSCALL(__NR_mknodat),
#if defined(__x86_64__)
		OE_DENY_SYSCALL(__NR_mknod),
#endif
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	int fd = (int)syscall(SYS_memfd_create, "pi-payload-seccomp", MFD_CLOEXEC | MFD_ALLOW_SEALING);
	if (fd < 0) return -1;
	if (write_all(fd, (const unsigned char *)filter, sizeof(filter)) < 0 || lseek(fd, 0, SEEK_SET) < 0 ||
		fcntl(fd, F_ADD_SEALS, F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK) < 0) {
		int error = errno; close(fd); errno = error; return -1;
	}
	return fd;
}

#undef OE_DENY_SYSCALL
#undef OE_AUDIT_ARCH
#endif
