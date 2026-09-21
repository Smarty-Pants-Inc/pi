#ifndef PI_OWNER_RECORD_H
#define PI_OWNER_RECORD_H

#include <stdint.h>
#include <string.h>

#define OE_RECORD_VERSION 3U

/* A claim belongs to the non-branchable owner control record. Clean retirement
 * retains it. Recovery never reconstructs permission or replenishes counters. */
typedef struct __attribute__((packed)) {
	char id[65];
	char decision[65];
	char instruction[65];
	char principal[65];
	uint64_t not_before_ms;
	uint64_t expires_ms;
	uint64_t last_wall_ms;
	uint32_t inference_limit;
	uint32_t inference_spent;
	uint32_t count_limit;
	uint32_t count_spent;
	uint32_t automatic_limit;
	uint32_t automatic_spent;
	uint32_t automatic_stopped;
} OwnerAllocation;

static inline int oe_allocation_digest(const char value[65]) {
	for (unsigned i = 0; i < 64; i++) {
		if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
	}
	return value[64] == 0;
}

static inline int oe_valid_allocation(const OwnerAllocation *allocation) {
	if (!allocation->id[0]) {
		const OwnerAllocation empty = {0};
		return !memcmp(allocation, &empty, sizeof(empty));
	}
	return oe_allocation_digest(allocation->id) && oe_allocation_digest(allocation->decision) &&
		oe_allocation_digest(allocation->instruction) && oe_allocation_digest(allocation->principal) &&
		allocation->not_before_ms > 0 && allocation->expires_ms <= 9007199254740991ULL &&
		allocation->expires_ms > allocation->not_before_ms && allocation->last_wall_ms >= allocation->not_before_ms &&
		allocation->last_wall_ms < allocation->expires_ms && allocation->inference_limit > 0 && allocation->inference_limit <= 8 &&
		allocation->inference_spent <= allocation->inference_limit && allocation->count_limit <= 8 &&
		allocation->count_spent <= allocation->count_limit && allocation->automatic_limit <= 2 &&
		allocation->automatic_spent <= allocation->automatic_limit && allocation->automatic_stopped <= 1;
}

#define OE_RECORD_ACTIVE 1U
#define OE_RECORD_DRAINING 2U
#define OE_RECORD_RETIRED 3U
#define OE_RECORD_RECOVERING 4U
#define OE_RECORD_UNCERTAIN 5U
#define OE_RECORD_WRITE_PENDING 1U
#define OE_RECORD_LOCAL_PENDING 2U
#define OE_RECORD_REMOTE_PENDING 4U

/* A writable child and an in-process write hold the same crash-recovery fence.
 * Completing either must not clear custody of the other or a journal append. */
static inline uint32_t oe_local_mutation_flags(uint32_t flags, unsigned operations, unsigned launches) {
	return operations || launches ? flags | OE_RECORD_LOCAL_PENDING : flags & ~OE_RECORD_LOCAL_PENDING;
}

/* Private control metadata, NOT session JSONL. Fixed little-endian v3 layout;
 * packed fields and a size/version check keep x64 and arm64 correspondence
 * explicit. Native session encoding remains in SessionManager. */
typedef struct __attribute__((packed)) {
	char magic[8];
	uint32_t version;
	uint32_t bytes;
	uint32_t disposition;
	uint32_t uncertainty;
	uint64_t pid;
	uint64_t start_ticks;
	uint64_t root_device;
	uint64_t root_inode;
	uint64_t root_mount;
	uint64_t storage_device;
	uint64_t storage_inode;
	uint64_t lock_device;
	uint64_t lock_inode;
	uint64_t stop_generation;
	uint64_t sequence;
	uint64_t journal_size;
	uint64_t journal_device;
	uint64_t journal_inode;
	uint32_t operations;
	uint32_t launch_count;
	char boot[40];
	char invocation[40];
	char unit[144];
	char cgroup[512];
	char profile[65];
	char grant[65];
	char lock_name[192];
	char journal_name[192];
	char group[40];
	char launches[64][32];
	OwnerAllocation allocation;
} OwnerRecord;

_Static_assert(sizeof(OwnerRecord) <= 4096, "Owner control record exceeds minimum profile budget");

#endif
