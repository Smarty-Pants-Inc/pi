/* Original operation/socket custody. TLS and Responses decoding remain in the
 * trusted native Node transport/parser; this module owns the kernel socket. */
static Operation *provider_operation(napi_env env, napi_value value, bool terminal) {
	bool tagged = false;
	void *pointer = NULL;
	if (napi_check_object_type_tag(env, value, &operation_tag, &tagged) != napi_ok || !tagged ||
		napi_unwrap(env, value, &pointer) != napi_ok) return NULL;
	Operation *operation = pointer;
	if (operation->owner->lifecycle || operation->kind != OE_EFFECT_PROVIDER || !operation->dispatched || operation->completed || operation->unknown ||
		!operation->owner->active || operation->owner->generation != operation->generation ||
		!operation->owner->allocation.id[0] || !operation->owner->remote_operations || (!terminal && !operation_allowed(operation))) return NULL;
	return operation;
}

static napi_value connect_provider(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value args[2], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Operation *operation = argc == 2 ? provider_operation(env, args[0], false) : NULL;
	char address[INET6_ADDRSTRLEN];
	unsigned port;
	if (!operation || operation->provider_socket || operation->owner->provider_sockets >= OE_MAX_PROVIDER_SOCKETS ||
		!named_string(env, args[1], "address", address, sizeof(address)) || !get_u32(env, args[1], "port", &port) || !port || port > 65535) {
		return failure(env, "OWNER_PROVIDER_CONNECT_ARGUMENT", EINVAL);
	}
	char url[4096], method[8], expected[4096];
	int length = snprintf(expected, sizeof(expected), "%s%sresponses", operation->admission->base_url,
		operation->admission->base_url[strlen(operation->admission->base_url) - 1] == '/' ? "" : "/");
	if (length < 0 || (size_t)length >= sizeof(expected) ||
		!named_string(env, args[1], "url", url, sizeof(url)) || !named_string(env, args[1], "method", method, sizeof(method)) ||
		strcmp(method, "POST") || strcmp(url, operation->count_operation ? operation->admission->count_url : expected)) {
		return failure(env, "OWNER_PROVIDER_ENDPOINT_SCOPE", EPERM);
	}
	if (operation->count_operation) {
		char id[257], body[65], payload[65];
		if (!named_string(env, args[1], "requestId", id, sizeof(id)) || strcmp(id, operation->count_request_id) ||
			!named_string(env, args[1], "countBodyHash", body, sizeof(body)) || strcmp(body, operation->count_body_hash) ||
			!named_string(env, args[1], "payloadHash", payload, sizeof(payload)) || strcmp(payload, operation->inference_payload_hash)) {
			return failure(env, "OWNER_COUNT_REQUEST_SCOPE", EPERM);
		}
	}
	LockRequest request = {.operation = 6, .slot = operation->owner->holder->slot, .generation = operation->generation,
		.connection = operation->owner->provider_sockets};
	struct sockaddr_in *v4 = (struct sockaddr_in *)&request.peer;
	struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&request.peer;
	int family;
	if (inet_pton(AF_INET, address, &v4->sin_addr) == 1) {
		family = AF_INET; v4->sin_family = AF_INET; v4->sin_port = htons((uint16_t)port); request.peer_length = sizeof(*v4);
	} else if (inet_pton(AF_INET6, address, &v6->sin6_addr) == 1) {
		family = AF_INET6; v6->sin6_family = AF_INET6; v6->sin6_port = htons((uint16_t)port); request.peer_length = sizeof(*v6);
	} else return failure(env, "OWNER_PROVIDER_ADDRESS", EINVAL);
	/* Argument property access can reenter JS. Recheck the captured original
	 * operation after copying, before creating or transferring any socket. */
	if (!operation_allowed(operation) || operation->completed || operation->unknown || operation->provider_socket ||
		operation->owner->provider_sockets >= OE_MAX_PROVIDER_SOCKETS) return failure(env, "OWNER_PROVIDER_CONNECT_STALE", ESTALE);
	request.connection = operation->owner->provider_sockets;
	int fd = socket(family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, IPPROTO_TCP);
	if (fd < 0) return failure(env, "OWNER_PROVIDER_SOCKET", errno);
	if (fstat(fd, &operation->provider_identity) < 0) { int error = errno; close(fd); return failure(env, "OWNER_PROVIDER_SOCKET", error); }
	operation->provider_fd = fd;
	operation->provider_socket = true;
	operation->provider_slot = operation->owner->provider_sockets++;
	/* The existing holder connects AFTER receiving its own descriptor. Its kernel
	 * deadlines/stop channel can shut down this exact socket even with JS blocked. */
	if (holder_roundtrip(operation->host, &request, fd) < 0) {
		int error = errno;
		close(fd); operation->provider_fd = -1;
		quarantine_owner(operation->owner);
		return failure(env, "OWNER_PROVIDER_CONNECT", error);
	}
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}

static napi_value take_provider_socket(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value value, result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, &value, NULL, NULL));
	Operation *operation = argc == 1 ? provider_operation(env, value, false) : NULL;
	if (!operation || !operation->provider_socket || operation->provider_fd < 0 || operation->provider_transferred) {
		return failure(env, "OWNER_PROVIDER_SOCKET_STATE", ESTALE);
	}
	struct pollfd event = {.fd = operation->provider_fd, .events = POLLOUT};
	int ready = poll(&event, 1, 0);
	if (ready < 0) return failure(env, "OWNER_PROVIDER_CONNECT_POLL", errno);
	if (!ready) { NAPI_CALL(env, napi_get_null(env, &result)); return result; }
	int error = 0;
	socklen_t size = sizeof(error);
	if (getsockopt(operation->provider_fd, SOL_SOCKET, SO_ERROR, &error, &size) < 0) error = errno;
	if (!error && (event.revents & (POLLERR | POLLHUP | POLLNVAL))) error = ECONNRESET;
	if (error || !operation_allowed(operation)) return failure(env, "OWNER_PROVIDER_CONNECT_FAILED", error ? error : ESTALE);
	/* Node's documented net.Socket({fd}) takes the single H descriptor. No native
	 * code closes that descriptor number after transfer: it might later be reused. */
	NAPI_CALL(env, napi_create_int32(env, operation->provider_fd, &result));
	operation->provider_transferred = true;
	return result;
}

static napi_value retire_provider(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value args[3], result;
	NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));
	Operation *operation = argc == 3 ? provider_operation(env, args[0], true) : NULL;
	char response[257], terminal[16];
	if (!operation || !operation->provider_transferred || operation->provider_retired ||
		!get_string(env, args[1], response, sizeof(response)) || !response[0] ||
		!get_string(env, args[2], terminal, sizeof(terminal)) ||
		(operation->count_operation ? (strcmp(terminal, "counted") || strcmp(response, operation->count_request_id)) :
			(strcmp(terminal, "completed") && strcmp(terminal, "incomplete") && strcmp(terminal, "failed")))) {
		return failure(env, "OWNER_PROVIDER_TERMINAL", EINVAL);
	}
	/* A JS close event alone cannot clear remote-pending. Verify that H's actual
	 * original descriptor is gone before shutting down and closing the holder's
	 * final kernel reference. Parser provenance is enforced by the private caller. */
	struct stat current;
	int found = fstat(operation->provider_fd, &current);
	if ((found < 0 && errno != EBADF) || (found == 0 && current.st_dev == operation->provider_identity.st_dev &&
		current.st_ino == operation->provider_identity.st_ino)) return failure(env, "OWNER_PROVIDER_SOCKET_NOT_CLOSED", EBUSY);
	LockRequest request = {.operation = 7, .slot = operation->owner->holder->slot,
		.generation = operation->generation, .connection = operation->provider_slot};
	if (holder_roundtrip(operation->host, &request, -1) < 0) return failure(env, "OWNER_PROVIDER_SOCKET_RETIREMENT", errno);
	operation->provider_fd = -1;
	operation->provider_retired = true;
	NAPI_CALL(env, napi_get_undefined(env, &result));
	return result;
}
