#ifndef PI_OWNER_RESOURCES_H
#define PI_OWNER_RESOURCES_H

/* Additive resource-inspection ABI 1. No new owner, descriptor, grant or finalizer. */
_Static_assert(sizeof(rlim_t) <= sizeof(uint64_t), "resource limits require u64 representation");

/* Define own data: assignment could invoke an inherited consumer setter. */
static napi_status resource_property(napi_env env, napi_value object, const char *name, napi_value value) {
	const napi_property_descriptor property = {name, NULL, NULL, NULL, NULL, value, napi_enumerable, NULL};
	return napi_define_properties(env, object, 1, &property);
}

static napi_status resource_string(napi_env env, napi_value object, const char *name, const char *text) {
	napi_value value;
	napi_status status = napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
	return status == napi_ok ? resource_property(env, object, name, value) : status;
}

static napi_value inspect_resources(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value input, result, value;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &input, NULL, NULL));
	LeaseRef *reference = NULL;
	Owner *owner = argc == 1 ? get_owner(env, input, &reference, false) : NULL;
	if (!owner) return failure(env, "OWNER_RESOURCE_STALE", ESTALE);
	Host *host = reference->host;
	struct stat st;
	struct statfs fs;
	struct rlimit nofile;
	struct timespec observed;
	int error = 0;
	const char *stage = "OWNER_RESOURCE_CUSTODY";
	pthread_mutex_lock(&host->gate);
	if (host->closing || host->closed || !owner->admission || !owner->allocation.id[0] || !admission_current(owner->admission)) {
		error = ESTALE;
	} else if (fstat(host->cgroup, &st) < 0 || fstatfs(host->cgroup, &fs) < 0) {
		error = errno;
	} else if (!S_ISDIR(st.st_mode) || fs.f_type != CGROUP2_SUPER_MAGIC ||
		(uint64_t)st.st_dev != host->cgroup_device || (uint64_t)st.st_ino != host->cgroup_inode) {
		error = ESTALE;
	} else if ((uint64_t)st.st_dev > UINT64_C(9007199254740991) || (uint64_t)st.st_ino > UINT64_C(9007199254740991)) {
		stage = "OWNER_RESOURCE_IDENTITY_RANGE"; error = EOVERFLOW;
	} else if (getrlimit(RLIMIT_NOFILE, &nofile) < 0) {
		stage = "OWNER_RESOURCE_NOFILE"; error = errno;
	} else if (clock_gettime(CLOCK_REALTIME, &observed) < 0) {
		stage = "OWNER_RESOURCE_CLOCK"; error = errno;
	} else if (observed.tv_sec < 0 || observed.tv_nsec < 0 || observed.tv_nsec >= 1000000000L) {
		stage = "OWNER_RESOURCE_CLOCK"; error = EINVAL;
	} else if (!admission_current(owner->admission)) {
		error = ESTALE;
	}
	pthread_mutex_unlock(&host->gate);
	if (error) return failure(env, stage, error);
	/* N-API result construction occurs after unlocking; no JS callback is invoked. */
	NAPI_CALL(env, napi_create_object(env, &result));
	const char *number_names[] = {"descriptor", "device", "inode", "realtimeNanoseconds"};
	int64_t numbers[] = {host->cgroup, (int64_t)st.st_dev, (int64_t)st.st_ino, observed.tv_nsec};
	for (unsigned i = 0; i < 4; i++) {
		NAPI_CALL(env, napi_create_int64(env, numbers[i], &value));
		NAPI_CALL(env, resource_property(env, result, number_names[i], value));
	}
	char soft[32], hard[32], seconds[32];
	if (nofile.rlim_cur == RLIM_INFINITY) snprintf(soft, sizeof(soft), "infinity");
	else snprintf(soft, sizeof(soft), "%llu", (unsigned long long)nofile.rlim_cur);
	if (nofile.rlim_max == RLIM_INFINITY) snprintf(hard, sizeof(hard), "infinity");
	else snprintf(hard, sizeof(hard), "%llu", (unsigned long long)nofile.rlim_max);
	snprintf(seconds, sizeof(seconds), "%llu", (unsigned long long)observed.tv_sec);
	NAPI_CALL(env, resource_string(env, result, "nofileSoft", soft));
	NAPI_CALL(env, resource_string(env, result, "nofileHard", hard));
	NAPI_CALL(env, resource_string(env, result, "realtimeSeconds", seconds));
	NAPI_CALL(env, resource_string(env, result, "ownerEpoch", owner->grant));
	NAPI_CALL(env, resource_string(env, result, "allocationId", owner->allocation.id));
	NAPI_CALL(env, resource_string(env, result, "profileSha256", host->profile_digest));
	NAPI_CALL(env, resource_string(env, result, "hostInvocation", host->invocation));
	return result;
}
#endif
