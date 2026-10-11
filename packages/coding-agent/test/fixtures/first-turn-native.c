/* smarty-code#1681: isolated storage integration, not host/admission qualification.
 * Like session-append-only-native.c, construct low-level test metadata, but use
 * the production N-API read/commit/append/verify callbacks and storage bodies.
 * No provider/effect process, cgroup mutation or alternate transcript writer. */
#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc)
#include "../../native/owner-effects/owner-effects.c"

static void probe_finalize(napi_env env, void *data, void *hint) {
	(void)env; (void)hint;
	LeaseRef *ref = data;
	Host *host = ref->host;
	Owner *owner = &host->owners[0];
	free(owner->record_bytes);
	free(owner->journal_bytes);
	close(owner->holder->control);
	close(host->storage);
	close(host->cgroup);
	pthread_mutex_destroy(&host->gate);
	free(host);
	free(ref);
}

static napi_value probe_open(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value args[3], result;
	char directory[PATH_MAX], name[192];
	bool existing;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	if (argc != 3 || !get_string(env, args[0], directory, sizeof(directory)) ||
		!get_string(env, args[1], name, sizeof(name)) || !component(name) ||
		napi_get_value_bool(env, args[2], &existing) != napi_ok)
		return failure(env, "PROBE_ARGUMENT", EINVAL);
	Host *host = calloc(1, sizeof(*host));
	LeaseRef *ref = calloc(1, sizeof(*ref));
	if (!host || !ref) { free(host); free(ref); return failure(env, "PROBE_MEMORY", ENOMEM); }
	ref->host = host; ref->generation = 1;
	host->storage = host->cgroup = -1;
	Owner *owner = &host->owners[0];
	owner->holder = &host->holders[0]; owner->holder->control = -1;
	pthread_mutex_init(&host->gate, NULL);
	snprintf(host->storage_path, sizeof(host->storage_path), "%s", directory);
	host->storage = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	host->cgroup = open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	host->journal_limit = OE_MAX_JOURNAL; host->record_limit = OE_MAX_CONTROL;
	snprintf(host->unit, sizeof(host->unit), "probe.service");
	snprintf(host->cgroup_path, sizeof(host->cgroup_path), "/probe.slice/probe.service");
	memset(host->profile_digest, '0', 64); memset(host->invocation, '0', 32);
	int error = 0;
	if (host->storage < 0 || host->cgroup < 0 ||
		read_small_at(AT_FDCWD, "/proc/sys/kernel/random/boot_id", host->boot, sizeof(host->boot) - 1) <= 0) error = errno;
	host->boot[strcspn(host->boot, "\n")] = 0;
	owner->active = true; owner->generation = 1;
	owner->directory = host->storage; owner->group = owner->effects = -1;
	memset(owner->grant, '0', 64);
	snprintf(owner->lock_name, sizeof(owner->lock_name), "first-turn.lock");
	snprintf(owner->record_name, sizeof(owner->record_name), "first-turn.owner");
	snprintf(owner->journal_name, sizeof(owner->journal_name), "%s", name);
	snprintf(owner->group_name, sizeof(owner->group_name), "o-00000000000000000000000000000000");
	if (!error) {
		int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | (existing ? 0 : O_CREAT | O_EXCL);
		/* No holder thread in this probe; retain the real OFD lock here. */
		owner->holder->control = openat(host->storage, owner->lock_name, flags, 0600);
		if (owner->holder->control < 0) error = errno;
	}
	struct stat st;
	if (!error && fstat(owner->holder->control, &st) < 0) error = errno;
	if (!error) {
		owner->lock_device = (uint64_t)st.st_dev; owner->lock_inode = (uint64_t)st.st_ino;
		struct flock lock = {.l_type = F_WRLCK, .l_whence = SEEK_SET};
		if (fcntl(owner->holder->control, F_OFD_SETLK, &lock) < 0) error = errno;
	}
	if (!error && existing) {
		OwnerRecord record;
		if (read_owner_record(owner, &record) < 0) error = errno;
		else if (!valid_owner_record(&record) || record.uncertainty || record.operations || record.launch_count ||
			record.lock_device != owner->lock_device || record.lock_inode != owner->lock_inode ||
			strcmp(record.journal_name, name) || producer_dead(&record) != 1) error = ESTALE;
		else {
			owner->journal_size = record.journal_size;
			owner->journal_device = record.journal_device; owner->journal_inode = record.journal_inode;
			owner->sequence = record.sequence;
			owner->record_bytes = malloc(sizeof(record));
			if (!owner->record_bytes) error = ENOMEM;
			else { memcpy(owner->record_bytes, &record, sizeof(record)); owner->record_length = sizeof(record); }
		}
	}
	if (error) { probe_finalize(env, ref, NULL); return failure(env, "PROBE_OPEN", error); }
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, ref, probe_finalize, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &lease_tag));
	return result;
}

NAPI_MODULE_INIT() {
	const napi_property_descriptor properties[] = {
		{"open", NULL, probe_open, NULL, NULL, NULL, napi_default, NULL},
		{"check", NULL, check, NULL, NULL, NULL, napi_default, NULL},
		{"readJournal", NULL, read_journal, NULL, NULL, NULL, napi_default, NULL},
		{"commitJournal", NULL, commit_journal, NULL, NULL, NULL, napi_default, NULL},
		{"appendJournal", NULL, append_journal, NULL, NULL, NULL, napi_default, NULL},
		{"verifyJournal", NULL, append_journal, NULL, NULL, NULL, napi_default, (void *)1},
	};
	NAPI_CALL(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
	return exports;
}
