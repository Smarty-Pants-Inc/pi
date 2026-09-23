#ifndef PI_OWNER_LIFECYCLE_H
#define PI_OWNER_LIFECYCLE_H

/* Private retained work on the runtime's native work queue. No worker receives
 * a new grant, owner, supervisor, or public executor. The main thread alone
 * admits work and acknowledges its original completion. Worker I/O never holds
 * Host.gate: a blocked A must not lock an independently admitted B out of H. */
#define OE_LIFECYCLE_SEAL 1U
#define OE_LIFECYCLE_RELEASE_PREPARE 2U
#define OE_LIFECYCLE_RELEASE_COMMIT 3U
#define OE_LIFECYCLE_STOP 4U
#define OE_LIFECYCLE_POLL 5U
#define OE_LIFECYCLE_RETIRE 6U
#define OE_LIFECYCLE_COMPLETE 7U
#define OE_LIFECYCLE_JOURNAL 8U

typedef struct {
	char name[192];
	unsigned char *bytes;
	size_t previous_bytes;
	size_t next_bytes;
} LifecycleJournal;

struct LifecycleTask {
	Host *host;
	Owner *owner;
	unsigned slot;
	uint64_t generation;
	uint64_t deadline;
	unsigned action;
	Launch *launch;
	Operation *operation;
	LifecycleJournal *journal;
	unsigned char chunks[3][16384];
	size_t lengths[3];
	bool drained;
	atomic_bool cancelled;
	bool finished;
	bool accepted;
	bool quarantine;
	int error;
	napi_async_work work;
	napi_deferred ready;
	napi_ref input;
	napi_ref receipt;
};

static bool cancel_pending_lifecycle(Owner *owner) {
	if (!owner->lifecycle) return false;
	atomic_store(&owner->lifecycle->cancelled, true);
	return true;
}

static const atomic_bool *lifecycle_cancellation(const Owner *owner) {
	return owner->lifecycle ? &owner->lifecycle->cancelled : NULL;
}

static uint64_t lifecycle_deadline(const LifecycleTask *task) {
	uint64_t deadline = task->deadline;
	uint64_t closing = atomic_load(&task->owner->close_deadline);
	uint64_t stopping = task->launch ? atomic_load(&task->launch->stop_deadline) : 0;
	if (closing && closing < deadline) deadline = closing;
	if (stopping && stopping < deadline) deadline = stopping;
	return deadline;
}

static int lifecycle_journal_boundary(const Owner *owner) {
	if (!owner->lifecycle) return 0;
	if (atomic_load(&owner->lifecycle->cancelled)) return ECANCELED;
	return check_close_deadline(lifecycle_deadline(owner->lifecycle)) < 0 ? errno : 0;
}

static bool lifecycle_live(LifecycleTask *task) {
	if (task->error) return false;
	if (atomic_load(&task->cancelled)) task->error = ECANCELED;
	else if (check_close_deadline(lifecycle_deadline(task)) < 0) task->error = errno;
	return !task->error;
}

static napi_value lifecycle_remaining(napi_env env, napi_callback_info info) {
	size_t argc = 0;
	void *data = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, NULL, NULL, &data));
	LifecycleTask *task = data;
	uint64_t now = clock_milliseconds(CLOCK_MONOTONIC);
	uint64_t deadline = task->accepted ? 0 : lifecycle_deadline(task);
	napi_value result;
	NAPI_CALL(env, napi_create_double(env, !now || now >= deadline || atomic_load(&task->cancelled)
		? 0 : (double)(deadline - now), &result));
	return result;
}

static bool lifecycle_result(LifecycleTask *task, int result) {
	if (result < 0 && !task->error) task->error = errno;
	return lifecycle_live(task);
}

static void lifecycle_execute(napi_env env, void *data) {
	(void)env; /* Worker code must never call N-API. */
	LifecycleTask *task = data;
	Owner *owner = task->owner;
	Host *host = task->host;
	if (!lifecycle_live(task)) return;
	if (task->action == OE_LIFECYCLE_SEAL) {
		if (owner->provider_sockets && !lifecycle_result(task,
			lock_roundtrip(host, 8, task->slot, task->generation, NULL, -1))) return;
		if (owner->group >= 0 && !lifecycle_result(task, group_write(owner->group, "cgroup.kill", "1"))) return;
		if (!owner->recovering) (void)lifecycle_result(task, publish_owner_record(host, owner));
		return;
	}
	if (task->action == OE_LIFECYCLE_STOP) {
		Launch *launch = task->launch;
		if (launch->retired) return;
		launch->stopped = true;
		if (launch->pipes[0][1] >= 0) {
			int fd = launch->pipes[0][1]; launch->pipes[0][1] = -1;
			if (!lifecycle_result(task, close(fd))) return;
		}
		(void)lifecycle_result(task, group_write(launch->group, "cgroup.kill", "1"));
		return;
	}
	if (task->action == OE_LIFECYCLE_POLL) {
		Launch *launch = task->launch;
		for (unsigned i = 1; i < 4; i++) {
			if (!lifecycle_live(task)) return;
			ssize_t length = !launch->dispatched || launch->eof[i - 1] ? 0 :
				read(launch->pipes[i][0], task->chunks[i - 1], i == 3 ? 8 : sizeof(task->chunks[0]));
			if (length < 0 && errno != EAGAIN && errno != EINTR && !launch->error) launch->error = errno;
			if (!lifecycle_live(task)) return;
			if (length == 0 && launch->dispatched && !launch->eof[i - 1]) {
				launch->eof[i - 1] = true;
				int fd = launch->pipes[i][0]; launch->pipes[i][0] = -1;
				if (!lifecycle_result(task, close(fd))) return;
			}
			if (length < 0) length = 0;
			task->lengths[i - 1] = (size_t)length;
			if (i < 3) launch->output_bytes += (size_t)length;
			if (launch->output_bytes > host->output_limit) {
				if (!launch->error) launch->error = EOVERFLOW;
				if (!lifecycle_result(task, group_write(launch->group, "cgroup.kill", "1"))) return;
			}
		}
		if (!launch->exited && launch->pidfd >= 0) {
			siginfo_t status;
			memset(&status, 0, sizeof(status));
			if (waitid(P_PIDFD, (id_t)launch->pidfd, &status, WEXITED | WNOHANG | __WCLONE) < 0) {
				if (errno != EINTR) { task->error = errno; return; }
			} else if (status.si_pid) {
				launch->exited = true;
				launch->exit_code = status.si_code == CLD_EXITED ? status.si_status : -1;
				launch->signal = status.si_code == CLD_EXITED ? 0 : status.si_status;
				int fd = launch->pidfd; launch->pidfd = -1;
				if (!lifecycle_result(task, close(fd))) return;
			}
		}
		if (!lifecycle_live(task)) return;
		int empty = group_empty(launch->group);
		if (empty < 0) { task->error = errno; return; }
		task->drained = empty == 1 && ((!launch->dispatched && launch->stopped) ||
			(launch->exited && launch->eof[0] && launch->eof[1] && launch->eof[2]));
		(void)lifecycle_live(task);
		return;
	}
	if (task->action == OE_LIFECYCLE_RETIRE) {
		Launch *launch = task->launch;
		if (launch->dispatched && (!launch->exited || !launch->eof[0] || !launch->eof[1] || !launch->eof[2])) {
			task->error = EBUSY; return;
		}
		int empty = group_empty(launch->group);
		if (empty != 1) { task->error = empty < 0 ? errno : EBUSY; return; }
		if (!lifecycle_live(task) || !lifecycle_result(task, unlinkat(owner->group, launch->name, AT_REMOVEDIR))) return;
		int fd = launch->group; launch->group = -1;
		if (!lifecycle_result(task, close(fd))) return;
		close_launch_preparation(launch);
		if (!lifecycle_live(task)) return;
		launch->retired = true;
		if (launch->mutating) owner->mutating_launches--;
		owner->mutation_flags = oe_local_mutation_flags(owner->mutation_flags, owner->mutating_operations, owner->mutating_launches);
		if (!lifecycle_result(task, publish_owner_record(host, owner))) return;
		Launch **link = &owner->launches;
		while (*link && *link != launch) link = &(*link)->next;
		if (*link) *link = launch->next;
		owner->launch_count--;
		return;
	}
	if (task->action == OE_LIFECYCLE_JOURNAL) {
		LifecycleJournal *journal = task->journal;
		task->error = commit_journal_bytes(host, owner, journal->name,
			journal->bytes, journal->previous_bytes, journal->bytes, journal->next_bytes, true);
		(void)lifecycle_live(task);
		return;
	}
	if (task->action == OE_LIFECYCLE_COMPLETE) {
		Operation *operation = task->operation;
		if (operation->unknown || (operation->launch && !operation->launch->retired) ||
			(operation->mutating && operation->completion_failed) ||
			(operation->dispatched && operation->kind == OE_EFFECT_PROVIDER && !operation->provider_retired)) {
			operation->unknown = true;
			owner->uncertain = owner->sealed = true;
			if (owner->group >= 0) (void)group_write(owner->group, "cgroup.kill", "1");
			(void)publish_owner_record(host, owner);
			task->error = ENOTRECOVERABLE;
			return;
		}
		owner->operations--;
		if (operation->kind == OE_EFFECT_PROVIDER) {
			if (!operation->dispatched) {
				if (operation->count_operation) operation->admission->count_reserved--;
				else operation->admission->provider_reserved--;
			} else {
				owner->remote_operations--;
				if (!owner->remote_operations) owner->mutation_flags &= ~OE_RECORD_REMOTE_PENDING;
			}
		}
		if (operation->mutating) owner->mutating_operations--;
		owner->mutation_flags = oe_local_mutation_flags(owner->mutation_flags, owner->mutating_operations, owner->mutating_launches);
		(void)lifecycle_result(task, publish_owner_record(host, owner));
		/* completed is set only by H's original one-use receipt acceptance. */
		return;
	}
	if (task->action == OE_LIFECYCLE_RELEASE_PREPARE) {
		if (owner->group >= 0) {
			int empty = group_empty(owner->group);
			if (empty != 1) { task->error = empty < 0 ? errno : EBUSY; return; }
			if (!lifecycle_live(task)) return;
		}
		/* Release admission holds these executable descriptors until all launches
		 * and operations have drained. Close them here, not in H's receipt callback.
		 * Consume each descriptor once, retaining the first error and all remaining
		 * descriptors on cancellation/failure. No admitted JA close follows here. */
		if (owner->admission) {
			for (unsigned i = 0; i < owner->admission->command_count; i++) {
				if (!lifecycle_live(task)) return;
				int fd = owner->admission->commands[i].fd;
				owner->admission->commands[i].fd = -1;
				if (fd >= 0 && !lifecycle_result(task, close(fd))) return;
			}
		}
		int error = close_owner_credential(owner);
		if (error) { task->error = error; return; }
		if (!lifecycle_live(task) || !lifecycle_result(task,
			lock_roundtrip(host, 5, task->slot, task->generation, NULL, -1))) return;
		if (owner->group >= 0) {
			if (!lifecycle_result(task, unlinkat(owner->effects, owner->group_name, AT_REMOVEDIR))) return;
			int fd = owner->group;
			owner->group = -1; /* close consumes the descriptor, including on error. */
			if (!lifecycle_result(task, close(fd))) return;
		}
		if (owner->effects >= 0) {
			int fd = owner->effects;
			owner->effects = -1;
			if (!lifecycle_result(task, close(fd))) return;
		}
		owner->retired = true;
		(void)lifecycle_result(task, publish_owner_record(host, owner));
		/* Deliberately no JA release here. A delayed fsync cannot fall through
		 * into release. The original H must accept this specific preparation
		 * and admit the separate commit while the SAME deadline remains live. */
		return;
	}
	if (task->action == OE_LIFECYCLE_RELEASE_COMMIT) {
		owner->release_started = true;
		(void)lifecycle_result(task, lock_roundtrip(host, 2, task->slot, task->generation, NULL, -1));
		return;
	}
	task->error = EINVAL;
}

static void lifecycle_ready(napi_env env, napi_status status, void *data) {
	LifecycleTask *task = data;
	/* Runtime completion synchronizes all worker writes. It is not acceptance,
	 * and never starts another operation or releases an owner by itself. */
	task->finished = true;
	if (status != napi_ok && !task->error) task->error = EIO;
	napi_value value;
	if (napi_get_undefined(env, &value) == napi_ok) (void)napi_resolve_deferred(env, task->ready, value);
}

static void lifecycle_finalize(napi_env env, void *data, void *hint) {
	(void)hint;
	LifecycleTask *task = data;
	/* Failed/unknown tasks retain their receipt root and therefore their lease.
	 * They cannot be reclaimed or reused while a kernel call remains in flight. */
	if (!task->finished || !task->accepted) return;
	(void)napi_delete_async_work(env, task->work);
	(void)napi_delete_reference(env, task->input);
	if (task->journal) { free(task->journal->bytes); free(task->journal); }
	free(task);
}

static napi_value lifecycle_prepare(napi_env env, napi_value input, LeaseRef *reference, unsigned action, bool quarantine, Launch *launch, Operation *operation, LifecycleJournal *journal, LifecycleTask *predecessor);

static napi_value lifecycle_accept(napi_env env, napi_callback_info info) {
	size_t argc = 0;
	void *data = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, NULL, NULL, &data));
	LifecycleTask *task = data;
	Owner *owner = task->owner;
	if (!task->finished || task->accepted || owner->lifecycle != task ||
		!owner->active || owner->generation != task->generation) return failure(env, "OWNER_LIFECYCLE_RECEIPT", ESTALE);
	if (!lifecycle_live(task) || task->quarantine) {
		owner->uncertain = owner->sealed = true;
		return failure(env, "OWNER_LIFECYCLE_UNKNOWN", task->error ? task->error : ENOTRECOVERABLE);
	}
	/* A fallible receipt allocation must leave this finished task retained and
	 * non-retryable. Clear this provisional error only after construction. */
	task->error = ENOMEM;
	napi_value result, next, value;
	NAPI_CALL(env, napi_create_object(env, &result));
	NAPI_CALL(env, napi_get_null(env, &next));
	NAPI_CALL(env, napi_get_undefined(env, &value));
	if (task->action == OE_LIFECYCLE_JOURNAL)
		NAPI_CALL(env, napi_create_double(env, (double)task->journal->next_bytes, &value));
	if (task->action == OE_LIFECYCLE_POLL) {
		NAPI_CALL(env, napi_create_object(env, &value));
		const char *chunks[] = {"stdout", "stderr", "execError"};
		for (unsigned i = 0; i < 3; i++) {
			napi_value chunk;
			NAPI_CALL(env, napi_create_buffer_copy(env, task->lengths[i], task->chunks[i], NULL, &chunk));
			napi_property_descriptor property = {.utf8name = chunks[i], .value = chunk, .attributes = napi_default};
			NAPI_CALL(env, napi_define_properties(env, value, 1, &property));
		}
		const char *numbers[] = {"code", "signal", "error"};
		int values[] = {task->launch->exit_code, task->launch->signal, task->launch->error};
		for (unsigned i = 0; i < 3; i++) {
			napi_value number;
			NAPI_CALL(env, napi_create_int32(env, values[i], &number));
			napi_property_descriptor property = {.utf8name = numbers[i], .value = number, .attributes = napi_default};
			NAPI_CALL(env, napi_define_properties(env, value, 1, &property));
		}
		const char *flags[] = {"dispatched", "drained", "sampleExpired"};
		bool states[] = {task->launch->dispatched, task->drained,
			check_close_deadline(task->launch->sample_deadline) < 0};
		for (unsigned i = 0; i < 3; i++) {
			napi_value flag;
			NAPI_CALL(env, napi_get_boolean(env, states[i], &flag));
			napi_property_descriptor property = {.utf8name = flags[i], .value = flag, .attributes = napi_default};
			NAPI_CALL(env, napi_define_properties(env, value, 1, &property));
		}
	}
	/* Define own data properties: an inherited setter must not intercept the
	 * original receipt or re-enter acceptance during its construction. */
	napi_property_descriptor returned_value = {.utf8name = "value", .value = value, .attributes = napi_default};
	NAPI_CALL(env, napi_define_properties(env, result, 1, &returned_value));
	LifecycleTask *successor = NULL;
	if (task->action == OE_LIFECYCLE_RELEASE_PREPARE) {
		napi_value input;
		NAPI_CALL(env, napi_get_reference_value(env, task->input, &input));
		void *pointer = NULL;
		NAPI_CALL(env, napi_unwrap(env, input, &pointer));
		LeaseRef *reference = pointer;
		if (!reference || reference->host != task->host || reference->slot != task->slot ||
			reference->generation != task->generation) return failure(env, "OWNER_LIFECYCLE_RECEIPT", ESTALE);
		/* Retain the successor without dispatch. Receipt allocation cannot admit
		 * an irreversible close, and the original deadline cannot be renewed. */
		next = lifecycle_prepare(env, input, reference, OE_LIFECYCLE_RELEASE_COMMIT, false, NULL, NULL, NULL, task);
		if (!next) { owner->uncertain = owner->sealed = true; return NULL; }
		successor = owner->lifecycle;
	}
	napi_property_descriptor returned_next = {.utf8name = "next", .value = next, .attributes = napi_default};
	napi_status status = napi_define_properties(env, result, 1, &returned_next);
	if (status == napi_ok) {
		task->error = 0;
		if (owner->uncertain || !owner->active || owner->generation != task->generation ||
			owner->lifecycle != (successor ? successor : task)) task->error = ESTALE;
		if (!lifecycle_live(task) || (successor && !lifecycle_live(successor))) status = napi_generic_failure;
	}
	/* All return data exists. No fallible JS receipt construction follows the
	 * dispatch. Worker readiness alone still cannot accept either receipt. */
	if (status == napi_ok && successor) status = napi_queue_async_work(env, successor->work);
	if (status != napi_ok) {
		if (!task->error) task->error = EIO;
		if (successor) {
			atomic_store(&successor->cancelled, true);
			if (!successor->error) successor->error = task->error;
			successor->finished = true; /* Never queued on this failure path. */
		}
		owner->uncertain = owner->sealed = true;
		return failure(env, "OWNER_LIFECYCLE_UNKNOWN", task->error);
	}
	task->accepted = true;
	if (!successor) {
		owner->lifecycle = NULL;
		if (task->action == OE_LIFECYCLE_COMPLETE) task->operation->completed = true;
		if (task->action == OE_LIFECYCLE_RELEASE_COMMIT) {
			owner->active = false;
			release_admission(env, owner);
			free(owner->record_bytes); owner->record_bytes = NULL; owner->record_length = 0;
		}
	}
	/* Keep the root through every failure branch, including dispatch failure.
	 * Once accepted, root deletion is bookkeeping, not a second completion.
	 * If deletion fails, retain the root rather than throwing after acceptance. */
	if (napi_delete_reference(env, task->receipt) == napi_ok) task->receipt = NULL;
	return result;
}

static napi_value lifecycle_prepare(napi_env env, napi_value input, LeaseRef *reference, unsigned action, bool quarantine, Launch *launch, Operation *operation, LifecycleJournal *journal, LifecycleTask *predecessor) {
	Owner *owner = &reference->host->owners[reference->slot];
	uint64_t deadline = atomic_load(&owner->close_deadline);
	if (launch) {
		uint64_t stopping = atomic_load(&launch->stop_deadline);
		uint64_t limit = stopping ? stopping : launch->sample_deadline + reference->host->close_timeout;
		if (!deadline || limit < deadline) deadline = limit;
	}
	if (operation && (!deadline || operation->completion_deadline < deadline)) deadline = operation->completion_deadline;
	if (predecessor && (!deadline || predecessor->deadline < deadline)) deadline = predecessor->deadline;
	if (owner->lifecycle != predecessor || check_close_deadline(deadline) < 0) {
		int error = owner->lifecycle != predecessor ? EBUSY : errno;
		if (journal) { free(journal->bytes); free(journal); }
		return failure(env, "OWNER_LIFECYCLE_ADMISSION", error);
	}
	LifecycleTask *task = calloc(1, sizeof(*task));
	if (!task) {
		if (journal) { free(journal->bytes); free(journal); }
		return failure(env, "OWNER_LIFECYCLE_MEMORY", ENOMEM);
	}
	task->host = reference->host; task->owner = owner;
	task->slot = reference->slot; task->generation = reference->generation;
	task->deadline = deadline; task->action = action; task->quarantine = quarantine; task->launch = launch;
	task->operation = operation; task->journal = journal;
	atomic_init(&task->cancelled, false);
	napi_value result, ready, complete, remaining, name;
	napi_status status = napi_create_object(env, &result);
	if (status == napi_ok) status = napi_create_promise(env, &task->ready, &ready);
	if (status == napi_ok) status = napi_create_function(env, "complete", NAPI_AUTO_LENGTH, lifecycle_accept, task, &complete);
	if (status == napi_ok) status = napi_create_function(env, "remaining", NAPI_AUTO_LENGTH, lifecycle_remaining, task, &remaining);
	if (status == napi_ok) {
		/* An extracted remaining function must keep the task finalizer alive. */
		napi_property_descriptor retained = {.utf8name = "completion", .value = complete, .attributes = napi_default};
		status = napi_define_properties(env, remaining, 1, &retained);
	}
	if (status == napi_ok) {
		napi_property_descriptor properties[] = {
			{.utf8name = "ready", .value = ready, .attributes = napi_default},
			{.utf8name = "complete", .value = complete, .attributes = napi_default},
			{.utf8name = "remaining", .value = remaining, .attributes = napi_default},
		};
		status = napi_define_properties(env, result, 3, properties);
	}
	if (status == napi_ok) status = napi_create_string_utf8(env, "original-owner-lifecycle", NAPI_AUTO_LENGTH, &name);
	if (status == napi_ok) status = napi_create_reference(env, input, 1, &task->input);
	if (status == napi_ok) status = napi_create_reference(env, result, 1, &task->receipt);
	if (status == napi_ok) status = napi_create_async_work(env, NULL, name, lifecycle_execute, lifecycle_ready, task, &task->work);
	if (status != napi_ok) {
		if (task->receipt) (void)napi_delete_reference(env, task->receipt);
		if (task->input) (void)napi_delete_reference(env, task->input);
		if (journal) { free(journal->bytes); free(journal); }
		free(task);
		return failure(env, "OWNER_LIFECYCLE_PREPARATION", ENOMEM);
	}
	/* Publish the retained original task before the runtime can dispatch it. */
	owner->lifecycle = task;
	status = napi_add_finalizer(env, complete, task, lifecycle_finalize, NULL, NULL);
	if (status == napi_ok && !predecessor) status = napi_queue_async_work(env, task->work);
	if (status != napi_ok) {
		task->error = EIO; task->finished = true;
		owner->uncertain = owner->sealed = true;
		return failure(env, "OWNER_LIFECYCLE_DISPATCH", EIO);
	}
	return result;
}

static napi_value lifecycle_queue(napi_env env, napi_value input, LeaseRef *reference, unsigned action, bool quarantine, Launch *launch, Operation *operation, LifecycleJournal *journal) {
	return lifecycle_prepare(env, input, reference, action, quarantine, launch, operation, journal, NULL);
}

static napi_value lifecycle_seal(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	void *quarantine = NULL;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, &quarantine));
	/* No get_owner filesystem check, mutex, persistence or kernel retirement on
	 * this thread. The opaque lease/generation still supplies original custody. */
	bool tagged = false;
	void *pointer = NULL;
	if (argc != 1 || napi_check_object_type_tag(env, value, &lease_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return failure(env, "STALE_OWNER", ESTALE);
	LeaseRef *reference = pointer;
	Owner *owner = &reference->host->owners[reference->slot];
	if (!owner->active || owner->generation != reference->generation) return failure(env, "STALE_OWNER", ESTALE);
	if (quarantine == (void *)3) {
		uint_fast64_t absent = 0;
		uint64_t deadline = close_deadline(reference->host->close_timeout);
		if (!deadline) return failure(env, "OWNER_CLOSE_DEADLINE", errno);
		(void)atomic_compare_exchange_strong(&owner->close_deadline, &absent, deadline);
		if (!atomic_exchange(&owner->sealed, true)) {
			uint_fast64_t generation = atomic_load(&owner->stop_generation);
			if (generation == UINT64_MAX) {
				(void)cancel_pending_lifecycle(owner);
				return failure(env, "OWNER_SEAL_GENERATION", EOVERFLOW);
			}
			(void)atomic_fetch_add(&owner->stop_generation, 1);
		}
		NAPI_CALL(env, napi_get_undefined(env, &result));
		return result;
	}
	if (quarantine == (void *)2) {
		(void)cancel_pending_lifecycle(owner);
		NAPI_CALL(env, napi_get_undefined(env, &result));
		return result;
	}
	if (owner->lifecycle) {
		if (!quarantine) return failure(env, "OWNER_LIFECYCLE_BUSY", EBUSY);
		/* Do not touch worker-owned fields or close its descriptors. */
		atomic_store(&owner->lifecycle->cancelled, true);
		NAPI_CALL(env, napi_get_undefined(env, &result));
		return result;
	}
	if (owner->release_started) return failure(env, "STALE_OWNER", ESTALE);
	if (!owner->close_deadline) owner->close_deadline = close_deadline(reference->host->close_timeout);
	if (!owner->sealed) {
		if (owner->stop_generation == UINT64_MAX) return failure(env, "OWNER_SEAL_GENERATION", EOVERFLOW);
		owner->stop_generation++;
	}
	owner->sealed = true;
	if (owner->allocation.id[0]) owner->allocation.automatic_stopped = 1;
	if (quarantine || atomic_load(&owner->holder->expiry_failed)) owner->uncertain = true;
	return lifecycle_queue(env, value, reference, OE_LIFECYCLE_SEAL, quarantine != NULL, NULL, NULL, NULL);
}

static napi_value lifecycle_release(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 1 ? get_owner(env, value, &reference, true) : NULL;
	if (!owner || owner->lifecycle || !owner->sealed || owner->uncertain || owner->recovering ||
		owner->mutation_flags || reference->host->failed || owner->launch_count || owner->operations)
		return failure(env, "OWNER_NOT_RETIRED", EBUSY);
	return lifecycle_queue(env, value, reference, OE_LIFECYCLE_RELEASE_PREPARE, false, NULL, NULL, NULL);
}

static napi_value request_stop_launch(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	bool tagged = false;
	void *pointer = NULL;
	if (argc != 1 || napi_check_object_type_tag(env, value, &launch_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return failure(env, "OWNER_LAUNCH_STATE", ESTALE);
	Launch *launch = pointer;
	if (!launch->owner->active || launch->owner->generation != launch->generation) return failure(env, "OWNER_LAUNCH_STATE", ESTALE);
	uint64_t deadline = close_deadline(launch->host->close_timeout);
	uint64_t sample_limit = launch->sample_deadline + launch->host->close_timeout;
	uint64_t closing = atomic_load(&launch->owner->close_deadline);
	if (sample_limit < deadline) deadline = sample_limit;
	if (closing && closing < deadline) deadline = closing;
	uint_fast64_t absent = 0;
	(void)atomic_compare_exchange_strong(&launch->stop_deadline, &absent, deadline);
	atomic_store(&launch->stop_requested, true);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value lifecycle_launch(napi_env env, napi_callback_info info, unsigned action) {
	size_t argc = 1;
	napi_value value, lease;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	Launch *launch = argc == 1 ? get_launch(env, value) : NULL;
	if (!launch || (launch->retired && action != OE_LIFECYCLE_STOP) ||
		(action == OE_LIFECYCLE_STOP && !atomic_load(&launch->stop_requested)))
		return failure(env, "OWNER_LAUNCH_STATE", ESTALE);
	NAPI_CALL(env, napi_get_reference_value(env, launch->lease_ref, &lease));
	LeaseRef *reference;
	if (!get_owner(env, lease, &reference, true)) return failure(env, "STALE_OWNER", ESTALE);
	return lifecycle_queue(env, value, reference, action, false, launch, NULL, NULL);
}

static napi_value associate_launch(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	bool tagged = false;
	void *pointer = NULL;
	if (argc != 2 || napi_check_object_type_tag(env, args[0], &operation_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, args[0], &pointer) != napi_ok) return failure(env, "OWNER_OPERATION_HANDLE", EINVAL);
	Operation *operation = pointer;
	Launch *launch = get_launch(env, args[1]);
	if (!launch || operation->owner != launch->owner || operation->generation != launch->generation ||
		operation->completed || operation->completion_deadline || operation->launch || launch->dispatched ||
		(operation->kind != OE_EFFECT_PROCESS && operation->kind != OE_EFFECT_WORKER))
		return failure(env, "OWNER_OPERATION_LAUNCH", ESTALE);
	NAPI_CALL(env, napi_create_reference(env, args[1], 1, &operation->launch_ref));
	if (operation->sample_deadline && operation->sample_deadline < launch->sample_deadline)
		launch->sample_deadline = operation->sample_deadline;
	operation->launch = launch;
	if (check_close_deadline(launch->sample_deadline) < 0)
		return failure(env, "OWNER_PROCESS_TIMEOUT", ETIMEDOUT);
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value lifecycle_operation(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], lease;
	bool failed;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	bool tagged = false;
	void *pointer = NULL;
	if (argc != 2 || napi_get_value_bool(env, args[1], &failed) != napi_ok ||
		napi_check_object_type_tag(env, args[0], &operation_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, args[0], &pointer) != napi_ok) return failure(env, "OWNER_OPERATION_HANDLE", EINVAL);
	Operation *operation = pointer;
	Owner *owner = operation->owner;
	if (owner->lifecycle || !owner->active || owner->generation != operation->generation ||
		operation->completed || operation->completion_deadline || !owner->operations)
		return failure(env, "OWNER_OPERATION_STALE", ESTALE);
	uint64_t deadline = close_deadline(operation->host->close_timeout);
	if (!deadline) return failure(env, "OWNER_OPERATION_DEADLINE", errno);
	if (operation->launch) {
		uint64_t sample = operation->launch->sample_deadline;
		uint64_t bound = failed ? sample + operation->host->close_timeout : sample;
		if (bound < deadline) deadline = bound;
	}
	/* Once-only completion admission; every stage is capped by the earlier
	 * original launch stop / owner close interval in lifecycle_queue/live. */
	operation->completion_deadline = deadline;
	operation->completion_failed = failed;
	NAPI_CALL(env, napi_get_reference_value(env, operation->lease_ref, &lease));
	LeaseRef *reference;
	if (!get_owner(env, lease, &reference, true)) return failure(env, "STALE_OWNER", ESTALE);
	return lifecycle_queue(env, args[0], reference, OE_LIFECYCLE_COMPLETE, false, operation->launch, operation, NULL);
}

static napi_value lifecycle_journal(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value args[4];
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	LeaseRef *reference;
	Owner *owner = argc == 4 ? get_owner(env, args[0], &reference, true) : NULL;
	char name[192];
	void *previous, *next;
	size_t previous_bytes, next_bytes;
	if (!owner || !get_string(env, args[1], name, sizeof(name)) || !component(name) ||
		napi_get_buffer_info(env, args[2], &previous, &previous_bytes) != napi_ok ||
		napi_get_buffer_info(env, args[3], &next, &next_bytes) != napi_ok)
		return failure(env, "OWNER_COMMIT_ARGUMENT", EINVAL);
	/* Copy bytes before dispatch; the worker never borrows mutable JS buffers. */
	if (!owner->sealed || owner->uncertain || owner->operations || owner->launch_count ||
		strcmp(name, owner->journal_name) || previous_bytes != owner->journal_size ||
		!next_bytes || next_bytes > reference->host->journal_limit || next_bytes < previous_bytes ||
		memcmp(previous, next, previous_bytes)) return failure(env, "OWNER_COMMIT_NOT_APPEND", EINVAL);
	LifecycleJournal *journal = calloc(1, sizeof(*journal));
	if (!journal) return failure(env, "OWNER_COMMIT_MEMORY", ENOMEM);
	journal->bytes = malloc(next_bytes);
	if (!journal->bytes) { free(journal); return failure(env, "OWNER_COMMIT_MEMORY", ENOMEM); }
	memcpy(journal->bytes, next, next_bytes);
	memcpy(journal->name, name, strlen(name) + 1);
	journal->previous_bytes = previous_bytes; journal->next_bytes = next_bytes;
	return lifecycle_queue(env, args[0], reference, OE_LIFECYCLE_JOURNAL, false, NULL, NULL, journal);
}

#endif
