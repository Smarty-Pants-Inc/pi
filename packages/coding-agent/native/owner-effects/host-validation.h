#ifndef PI_OWNER_HOST_VALIDATION_H
#define PI_OWNER_HOST_VALIDATION_H

#include <linux/capability.h>
#include <sys/quota.h>
#include <sys/statvfs.h>

static bool token_present(const char *text, const char *token, const char *separators) {
	size_t length = strlen(token);
	for (const char *p = text; *p;) {
		p += strspn(p, separators);
		size_t n = strcspn(p, separators);
		if (n == length && !memcmp(p, token, n)) return true;
		p += n;
	}
	return false;
}

static int host_privileges(unsigned uid, unsigned gid) {
	uid_t real, effective, saved;
	gid_t greal, geffective, gsaved;
	struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
	struct __user_cap_data_struct caps[2];
	if (getresuid(&real, &effective, &saved) < 0 || getresgid(&greal, &geffective, &gsaved) < 0 ||
		syscall(SYS_capget, &header, caps) < 0 || real != uid || effective != uid || saved != uid ||
		greal != gid || geffective != gid || gsaved != gid || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return -1;
	for (unsigned i = 0; i < 2; i++) if (caps[i].effective || caps[i].permitted || caps[i].inheritable) { errno = EPERM; return -1; }
	for (unsigned i = 0; i <= CAP_LAST_CAP; i++) {
		if (prctl(PR_CAPBSET_READ, i, 0, 0, 0) != 0 || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, i, 0, 0) != 0) { errno = EPERM; return -1; }
	}
	return 0;
}

/* nsdelegate is a cgroup-v2 superblock flag. Linux permits changing it only
 * from the initial mount namespace. Inspect the exact FD's full-root mount,
 * not an unrelated mount line or a namespaced mount command's exit status. */
static int host_cgroup_mount(int fd) {
	char mountinfo[OE_MAX_CONTROL];
	uint64_t wanted = mount_identity(fd);
	if (!wanted || read_small_at(AT_FDCWD, "/proc/self/mountinfo", mountinfo, sizeof(mountinfo) - 1) < 0) return -1;
	char *line_state = NULL;
	for (char *line = strtok_r(mountinfo, "\n", &line_state); line; line = strtok_r(NULL, "\n", &line_state)) {
		char *state = NULL;
		char *id = strtok_r(line, " ", &state);
		if (!id || strtoull(id, NULL, 10) != wanted) continue;
		if (!strtok_r(NULL, " ", &state) || !strtok_r(NULL, " ", &state)) break;
		char *root = strtok_r(NULL, " ", &state), *path = strtok_r(NULL, " ", &state);
		if (!root || !path || strcmp(root, "/") || strcmp(path, "/sys/fs/cgroup")) break;
		char *field;
		while ((field = strtok_r(NULL, " ", &state)) && strcmp(field, "-")) {}
		if (!field) break;
		char *kind = strtok_r(NULL, " ", &state), *source = strtok_r(NULL, " ", &state), *options = strtok_r(NULL, " ", &state);
		if (kind && source && options && !strcmp(kind, "cgroup2") && token_present(options, "nsdelegate", ",")) return 0;
		break;
	}
	errno = EPERM;
	return -1;
}

/* Accept an actual bounded filesystem or a hard UID quota on that filesystem.
 * All writable grants must share this device, so their capacities do not add up
 * to more than the advertised total. No quota mutation or counter substitute. */
static int host_storage_limit(int fd, unsigned bytes, unsigned inodes) {
	struct statfs fs;
	struct statvfs capacity;
	if (fstatfs(fd, &fs) < 0 || fstatvfs(fd, &capacity) < 0) return -1;
	if (fs.f_type == TMPFS_MAGIC || fs.f_type == RAMFS_MAGIC || fs.f_type == PROC_SUPER_MAGIC ||
		fs.f_type == SYSFS_MAGIC || fs.f_type == CGROUP2_SUPER_MAGIC) { errno = EPERM; return -1; }
	if (capacity.f_frsize && capacity.f_blocks && capacity.f_blocks <= bytes / capacity.f_frsize &&
		capacity.f_files && capacity.f_files <= inodes) return 0;
	struct dqblk quota;
	memset(&quota, 0, sizeof(quota));
	if (syscall(SYS_quotactl_fd, fd, QCMD(Q_GETQUOTA, USRQUOTA), getuid(), &quota) < 0) return -1;
	if ((quota.dqb_valid & (QIF_BLIMITS | QIF_ILIMITS)) != (QIF_BLIMITS | QIF_ILIMITS) ||
		!quota.dqb_bhardlimit || quota.dqb_bhardlimit > bytes / 1024U ||
		!quota.dqb_ihardlimit || quota.dqb_ihardlimit > inodes) { errno = EDQUOT; return -1; }
	return 0;
}

static int host_controllers(int fd, unsigned quota, unsigned period) {
	char controllers[256], cpu[128], *end;
	if (read_small_at(fd, "cgroup.controllers", controllers, sizeof(controllers) - 1) < 0 ||
		!token_present(controllers, "cpu", " \n") || !token_present(controllers, "memory", " \n") ||
		!token_present(controllers, "pids", " \n") || read_small_at(fd, "cpu.max", cpu, sizeof(cpu) - 1) < 0) return -1;
	errno = 0;
	unsigned long actual_quota = strtoul(cpu, &end, 10);
	if (errno || end == cpu || *end != ' ') { errno = EPERM; return -1; }
	char *start = end + 1;
	unsigned long actual_period = strtoul(start, &end, 10);
	if (errno || end == start || strcmp(end, "\n") || !actual_quota || !actual_period ||
		actual_quota > 2000000UL || actual_period > 1000000UL ||
		(uint64_t)actual_quota * period > (uint64_t)quota * actual_period) { errno = EPERM; return -1; }
	return 0;
}

#endif
