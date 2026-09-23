#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

/* RUN06 qualification payload, UNRUN. The original admitted native command must
 * launch this under the real owner. It deliberately does not clean up its tree:
 * only the original owner's stop/drain/retire path may end the qualification.
 * These PIDs are namespace-local DATA, never host death/retirement evidence. */
int main(void) {
	int ready[2];
	if (pipe(ready) < 0) return 111;
	pid_t child = fork();
	if (child < 0) return 112;
	if (child == 0) {
		close(ready[0]);
		pid_t grandchild = fork();
		if (grandchild < 0) _exit(113);
		if (grandchild == 0) {
			char message = 'G';
			if (write(ready[1], &message, 1) != 1) _exit(114);
			for (;;) pause();
		}
		char message = 'C';
		if (write(ready[1], &message, 1) != 1) _exit(115);
		for (;;) pause();
	}
	close(ready[1]);
	unsigned seen = 0;
	while (seen != 3) {
		char message;
		ssize_t n = read(ready[0], &message, 1);
		if (n < 0 && errno == EINTR) continue;
		if (n != 1 || (message != 'C' && message != 'G')) return 116;
		unsigned bit = message == 'C' ? 1U : 2U;
		if (seen & bit) return 117;
		seen |= bit;
	}
	close(ready[0]);
	if (printf("original-owner-tree-ready leader=%ld child=%ld\n", (long)getpid(), (long)child) < 0 || fflush(stdout)) return 118;
	/* Child and grandchild deliberately retain stdout/stderr. Leader exit alone
	 * cannot satisfy the original pipe EOF condition. */
	for (;;) pause();
}
