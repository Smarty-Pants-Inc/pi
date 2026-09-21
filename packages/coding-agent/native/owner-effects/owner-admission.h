#ifndef PI_OWNER_ADMISSION_H
#define PI_OWNER_ADMISSION_H

#define OE_EFFECT_PROCESS 1U
#define OE_EFFECT_READ 2U
#define OE_EFFECT_WRITE 4U
#define OE_EFFECT_WORKER 8U
#define OE_EFFECT_PROVIDER 16U
#define OE_MAX_COMMANDS 16U

/* Only issue_admission, holding the actual native host, creates this object.
 * Strings constrain an issued capability; none reconstructs one. No policy is
 * recovered from the journal/control record, inherited by a fork, or amended. */
struct Admission {
	napi_env env;
	Host *host;
	Owner *owner;
	uint64_t generation;
	uint64_t stop_generation;
	bool activated;
	unsigned read_roots;
	unsigned write_roots;
	unsigned effects;
	unsigned command_count;
	SandboxPath commands[OE_MAX_COMMANDS];
	char provider[128];
	char model[256];
	char api[128];
	char base_url[4096];
	unsigned provider_limit;
	unsigned provider_reserved;
	unsigned provider_spent;
	char count_url[4096];
	char count_model[1025];
	char count_purpose[1025];
	char count_account[1025];
	unsigned count_limit;
	unsigned count_reserved;
	unsigned count_spent;
	napi_ref lease_ref;
};

static const napi_type_tag admission_tag = {0x5c522be42b19fa05ULL, 1};

static bool admission_current(const Admission *admission) {
	const Owner *owner = admission->owner;
	return admission->activated && owner->admission == admission && owner->admitted &&
		owner->active && owner->generation == admission->generation && owner->stop_generation == admission->stop_generation &&
		!owner->release_started && !owner->sealed && !owner->uncertain && !owner->recovering &&
		!admission->host->failed && !admission->host->closing && allocation_current(admission->owner) &&
		owner_lock_matches(admission->host, admission->owner);
}

static unsigned effect_kind(const char *name) {
	if (!strcmp(name, "process")) return OE_EFFECT_PROCESS;
	if (!strcmp(name, "read")) return OE_EFFECT_READ;
	if (!strcmp(name, "write")) return OE_EFFECT_WRITE;
	if (!strcmp(name, "worker")) return OE_EFFECT_WORKER;
	if (!strcmp(name, "provider")) return OE_EFFECT_PROVIDER;
	return 0;
}

static bool admission_root_allowed(const Launch *launch, unsigned root, bool writable) {
	const Admission *admission = launch->admission;
	return root < launch->host->root_count && (admission->read_roots & (1U << root)) &&
		(!writable || ((admission->write_roots & (1U << root)) && launch->host->roots[root].writable));
}

static int admission_command(Launch *launch, const char *command) {
	const Admission *admission = launch->admission;
	if (!(admission->effects & OE_EFFECT_PROCESS)) { errno = EPERM; return -1; }
	for (unsigned i = 0; i < admission->command_count; i++) {
		if (strcmp(command, admission->commands[i].path)) continue;
		launch->command = i;
		return duplicate_fd(admission->commands[i].fd);
	}
	errno = EPERM;
	return -1;
}

static bool admission_launch_allowed(const Launch *launch) {
	const Admission *admission = launch->admission;
	if (!admission_current(admission) || admission->generation != launch->generation ||
		!(admission->effects & OE_EFFECT_PROCESS) || launch->command >= admission->command_count ||
		(launch->read_roots & ~admission->read_roots) || (launch->write_roots & ~admission->write_roots)) return false;
	for (unsigned i = 0; i < launch->host->root_count; i++) {
		if (!(launch->read_roots & (1U << i))) continue;
		if (!admission_root_allowed(launch, i, (launch->write_roots & (1U << i)) != 0) ||
			expected_directory(launch->host->roots[i].fd, launch->host->roots[i].path) < 0) return false;
	}
	for (unsigned i = 0; i < launch->subroot_count; i++) {
		const SandboxPath *root = &launch->subroots[i];
		if (root->fd < 0 || expected_directory(root->fd, root->path) < 0) return false;
	}
	return true;
}

static void close_admission_files(Admission *admission) {
	for (unsigned i = 0; i < admission->command_count; i++) {
		if (admission->commands[i].fd >= 0) close(admission->commands[i].fd);
		admission->commands[i].fd = -1;
	}
}

static void finalize_admission(napi_env env, void *data, void *hint) {
	(void)hint;
	Admission *admission = data;
	close_admission_files(admission);
	napi_delete_reference(env, admission->lease_ref);
	free(admission);
}

static void release_admission(napi_env env, Owner *owner) {
	if (!owner->admission) return;
	close_admission_files(owner->admission);
	owner->admission = NULL;
	napi_delete_reference(env, owner->admission_ref);
	owner->admission_ref = NULL;
}

static int receive_admission(napi_env env, Admission *admission, napi_value policy) {
	Host *host = admission->host;
	napi_value roots, effects, commands, provider, value;
	uint32_t count;
	if (napi_get_named_property(env, policy, "roots", &roots) != napi_ok ||
		napi_get_array_length(env, roots, &count) != napi_ok || count > host->root_count) { errno = EINVAL; return -1; }
	for (unsigned i = 0; i < count; i++) {
		unsigned index;
		char access[16];
		if (napi_get_element(env, roots, i, &value) != napi_ok || !get_u32(env, value, "index", &index) ||
			index >= host->root_count || (admission->read_roots & (1U << index)) ||
			!named_string(env, value, "access", access, sizeof(access)) ||
			(strcmp(access, "read-only") && strcmp(access, "read-write"))) { errno = EINVAL; return -1; }
		admission->read_roots |= 1U << index;
		if (!strcmp(access, "read-write")) {
			if (!host->roots[index].writable) { errno = EPERM; return -1; }
			admission->write_roots |= 1U << index;
		}
	}
	if (napi_get_named_property(env, policy, "effects", &effects) != napi_ok ||
		napi_get_array_length(env, effects, &count) != napi_ok || count > 5) { errno = EINVAL; return -1; }
	for (unsigned i = 0; i < count; i++) {
		char name[16];
		if (napi_get_element(env, effects, i, &value) != napi_ok || !get_string(env, value, name, sizeof(name))) { errno = EINVAL; return -1; }
		unsigned kind = effect_kind(name);
		if (!kind || (admission->effects & kind)) { errno = EINVAL; return -1; }
		admission->effects |= kind;
	}
	if (napi_get_named_property(env, policy, "commands", &commands) != napi_ok ||
		napi_get_array_length(env, commands, &count) != napi_ok || count > OE_MAX_COMMANDS ||
		((count != 0) != ((admission->effects & OE_EFFECT_PROCESS) != 0))) { errno = EINVAL; return -1; }
	for (unsigned i = 0; i < count; i++) {
		char command[PATH_MAX];
		if (napi_get_element(env, commands, i, &value) != napi_ok || !get_string(env, value, command, sizeof(command)) ||
			!sandbox_path(command)) { errno = EINVAL; return -1; }
		for (unsigned j = 0; j < i; j++) if (!strcmp(command, admission->commands[j].path)) { errno = EINVAL; return -1; }
		int fd = -1;
		for (unsigned j = 0; j < host->artifact_count; j++) if (!strcmp(command, host->artifacts[j].path)) {
			fd = duplicate_fd(host->artifacts[j].fd); break;
		}
		if (fd < 0 && beneath(host->tools_path, command)) {
			fd = beneath_open(host->tools, command + strlen(host->tools_path) + (command[strlen(host->tools_path)] == '/'), O_RDONLY);
		}
		struct stat st;
		if (fd < 0) { errno = EPERM; return -1; }
		if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 || st.st_nlink != 1 ||
			!(st.st_mode & 0111) || (st.st_mode & (0022 | S_ISUID | S_ISGID))) { close(fd); errno = EPERM; return -1; }
		SandboxPath *target = &admission->commands[admission->command_count++];
		target->fd = fd;
		snprintf(target->path, sizeof(target->path), "%s", command);
	}
	napi_valuetype type;
	if (napi_get_named_property(env, policy, "provider", &provider) != napi_ok || napi_typeof(env, provider, &type) != napi_ok) { errno = EINVAL; return -1; }
	if (type == napi_null) {
		if (admission->effects & OE_EFFECT_PROVIDER) { errno = EINVAL; return -1; }
	} else if (!(admission->effects & OE_EFFECT_PROVIDER) ||
		!named_string(env, provider, "provider", admission->provider, sizeof(admission->provider)) || !admission->provider[0] ||
		!named_string(env, provider, "model", admission->model, sizeof(admission->model)) || !admission->model[0] ||
		!named_string(env, provider, "api", admission->api, sizeof(admission->api)) || !admission->api[0] ||
		!named_string(env, provider, "baseUrl", admission->base_url, sizeof(admission->base_url)) || !admission->base_url[0] ||
		!get_u32(env, provider, "attempts", &admission->provider_limit) || !admission->provider_limit ||
		admission->provider_limit > host->operation_limit) { errno = EINVAL; return -1; }
	if (type != napi_null) {
		napi_value count_scope;
		napi_valuetype count_type;
		if (napi_get_named_property(env, provider, "count", &count_scope) != napi_ok ||
			napi_typeof(env, count_scope, &count_type) != napi_ok) { errno = EINVAL; return -1; }
		if (count_type != napi_undefined && count_type != napi_null) {
			char method[8], provider_name[128];
			if (!named_string(env, count_scope, "url", admission->count_url, sizeof(admission->count_url)) ||
				strncmp(admission->count_url, "https://", 8) ||
				!named_string(env, count_scope, "method", method, sizeof(method)) || strcmp(method, "POST") ||
				!named_string(env, count_scope, "provider", provider_name, sizeof(provider_name)) || strcmp(provider_name, admission->provider) ||
				!named_string(env, count_scope, "wireModel", admission->count_model, sizeof(admission->count_model)) || !admission->count_model[0] ||
				!named_string(env, count_scope, "purpose", admission->count_purpose, sizeof(admission->count_purpose)) || !admission->count_purpose[0] ||
				!named_string(env, count_scope, "account", admission->count_account, sizeof(admission->count_account)) || !admission->count_account[0] ||
				!get_u32(env, count_scope, "operations", &admission->count_limit) || !admission->count_limit || admission->count_limit > 8 ||
				admission->count_limit > host->operation_limit || !admission->owner->allocation.id[0]) { errno = EINVAL; return -1; }
		}
	}
	if (admission->count_limit != admission->owner->allocation.count_limit) { errno = EPERM; return -1; }
	if (!strncmp(admission->owner->lock_name, "allocation-", 11) &&
		(!admission->owner->allocation.id[0] || admission->owner->prior.allocation.id[0] ||
		admission->provider_limit != admission->owner->allocation.inference_limit || !allocation_current(admission->owner))) {
		errno = EPERM; return -1;
	}
	return 0;
}

/* Internal host-owner control plane. Neither a profile nor an acquire digest
 * calls this implicitly. The ordinary bootstrap must supply its real reviewed
 * authority here before it can be wired; there is no default/root-wide plan. */
static napi_value issue_admission(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value args[3], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 3 ? get_owner(env, args[1], &reference, false) : NULL;
	Host *host = argc == 3 ? get_host(env, args[0]) : NULL;
	if (!owner || !host || host != reference->host || owner->admission || owner->admitted) return failure(env, "OWNER_ADMISSION_ISSUER", EPERM);
	Admission *admission = calloc(1, sizeof(*admission));
	if (!admission) return failure(env, "OWNER_ADMISSION_MEMORY", ENOMEM);
	admission->env = env; admission->host = host; admission->owner = owner;
	admission->generation = reference->generation; admission->stop_generation = owner->stop_generation;
	if (receive_admission(env, admission, args[2]) < 0) {
		int error = errno; close_admission_files(admission); free(admission);
		return failure(env, "OWNER_ADMISSION_POLICY", error);
	}
	NAPI_CALL(env, napi_create_reference(env, args[1], 1, &admission->lease_ref));
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_wrap(env, result, admission, finalize_admission, NULL, NULL));
	NAPI_CALL(env, napi_type_tag_object(env, result, &admission_tag));
	napi_ref retained;
	NAPI_CALL(env, napi_create_reference(env, result, 1, &retained));
	pthread_mutex_lock(&host->gate);
	/* Policy access can reenter JS. Check the original incarnation after copying. */
	bool current = owner->active && owner->generation == admission->generation && owner->stop_generation == admission->stop_generation &&
		!owner->sealed && !owner->uncertain && !owner->recovering && !owner->release_started && !owner->admission && !owner->admitted &&
		!host->failed && !host->closing && owner_lock_matches(host, owner);
	if (current) { owner->admission = admission; owner->admission_ref = retained; }
	pthread_mutex_unlock(&host->gate);
	if (!current) { napi_delete_reference(env, retained); return failure(env, "OWNER_ADMISSION_STALE", ESTALE); }
	return result;
}

static napi_value activate_owner(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 2 ? get_owner(env, args[0], &reference, false) : NULL;
	bool tagged = false;
	void *pointer = NULL;
	if (!owner || napi_check_object_type_tag(env, args[1], &admission_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, args[1], &pointer) != napi_ok) return failure(env, "OWNER_ADMISSION_REQUIRED", EPERM);
	Admission *admission = pointer;
	Host *host = reference->host;
	pthread_mutex_lock(&host->gate);
	bool current = admission->env == env && admission->host == host && admission->owner == owner && owner->admission == admission &&
		admission->generation == reference->generation && owner->generation == reference->generation &&
		admission->stop_generation == owner->stop_generation && !admission->activated && !owner->admitted && owner->active &&
		!owner->release_started && !owner->sealed && !owner->uncertain && !owner->recovering && owner->journal_size &&
		!owner->mutation_flags && !host->failed && !host->closing && allocation_current(owner) && owner_lock_matches(host, owner);
	if (current) { admission->activated = true; owner->admitted = true; }
	pthread_mutex_unlock(&host->gate);
	if (!current) return failure(env, "OWNER_ADMISSION_STALE", ESTALE);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

#endif
