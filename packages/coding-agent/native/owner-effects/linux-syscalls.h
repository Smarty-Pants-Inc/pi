#ifndef PI_OWNER_LINUX_SYSCALLS_H
#define PI_OWNER_LINUX_SYSCALLS_H

#include <asm/unistd.h>
#include <stdint.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__ || defined(__ILP32__)
#error "Owner effects require a qualified 64-bit little-endian Linux ABI"
#endif

/* Child-only primitives: no libc errno, allocation, TLS or runtime callback. */
#if defined(__x86_64__)
static inline long oe_syscall6(long n, long a, long b, long c, long d, long e, long f) {
	register long r10 __asm__("r10") = d;
	register long r8 __asm__("r8") = e;
	register long r9 __asm__("r9") = f;
	long result;
	__asm__ volatile("syscall" : "=a"(result) : "a"(n), "D"(a), "S"(b), "d"(c),
		"r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory", "cc");
	return result;
}
#elif defined(__aarch64__)
static inline long oe_syscall6(long n, long a, long b, long c, long d, long e, long f) {
	register long x8 __asm__("x8") = n;
	register long x0 __asm__("x0") = a;
	register long x1 __asm__("x1") = b;
	register long x2 __asm__("x2") = c;
	register long x3 __asm__("x3") = d;
	register long x4 __asm__("x4") = e;
	register long x5 __asm__("x5") = f;
	__asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3),
		"r"(x4), "r"(x5) : "memory", "cc");
	return x0;
}
#else
#error "Owner effects require a qualified Linux x86-64 or aarch64 artifact"
#endif

static inline long oe_raw_close(int fd) {
	return oe_syscall6(__NR_close, fd, 0, 0, 0, 0, 0);
}

__attribute__((noreturn)) static inline void oe_raw_exit(int code) {
	oe_syscall6(__NR_exit_group, code, 0, 0, 0, 0, 0);
	/* A denied exit is still a contained obligation, never a return into H. */
	for (;;) oe_syscall6(__NR_exit, code, 0, 0, 0, 0, 0);
}

#endif
