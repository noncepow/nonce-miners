// keccak256 search kernel.
//
// The host pre-absorbs the padded 136-byte block into 25 lanes with the nonce's
// low 64 bits left zero. Each thread ORs its own nonce into the two lanes those
// bytes land in, runs the permutation, and reports any digest at or below the
// target. Only the low word varies, so the other lanes are computed once per
// launch on the CPU rather than once per thread.
//
// Nothing here is trusted: the host re-hashes every reported hit before it is
// used. A wrong kernel does not fail loudly, it returns plausible digests the
// contract rejects — which reads as bad luck rather than a bug.

typedef unsigned int u32;
typedef unsigned long long u64;

#define MAX_HITS 256

__device__ __constant__ u64 RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

__device__ __constant__ int RHO[25] = {
     0,  1, 62, 28, 27,
    36, 44,  6, 55, 20,
     3, 10, 43, 25, 39,
    41, 45, 15, 21,  8,
    18,  2, 61, 56, 14
};

struct Hit {
    u32 nonce_lo;
    u32 nonce_hi;
    u32 digest[8];
};

__device__ __forceinline__ u64 rotl64(u64 x, int n) {
    return (n == 0) ? x : ((x << n) | (x >> (64 - n)));
}

__device__ void keccak_f(u64 *st) {
    for (int round = 0; round < 24; round++) {
        u64 c[5], d[5];
        for (int x = 0; x < 5; x++)
            c[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
        for (int x = 0; x < 5; x++)
            d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++)
                st[x + 5 * y] ^= d[x];

        u64 b[25];
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++) {
                int i = x + 5 * y;
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(st[i], RHO[i]);
            }

        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++)
                st[x + 5 * y] = b[x + 5 * y]
                    ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);

        st[0] ^= RC[round];
    }
}

// Reverse byte order. The message is absorbed little-endian into lanes, but the
// nonce is a big-endian uint256, so its bytes arrive reversed.
__device__ __forceinline__ u64 bswap64(u64 v) {
    return ((v & 0x00000000000000ffULL) << 56) | ((v & 0x000000000000ff00ULL) << 40) |
           ((v & 0x0000000000ff0000ULL) << 24) | ((v & 0x00000000ff000000ULL) << 8)  |
           ((v & 0x000000ff00000000ULL) >> 8)  | ((v & 0x0000ff0000000000ULL) >> 24) |
           ((v & 0x00ff000000000000ULL) >> 40) | ((v & 0xff00000000000000ULL) >> 56);
}

extern "C" __global__ void search(
    const u64 *state,     // 25 pre-absorbed lanes
    const u32 *limit,     // target, big-endian, 8 words, most significant first
    u64 base,             // starting nonce, low 64 bits
    u32 count,            // how many nonces this launch covers
    u32 *hit_count,
    Hit *hits
) {
    u32 tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= count) return;

    u64 nonce = base + (u64)tid;

    u64 st[25];
    for (int i = 0; i < 25; i++) st[i] = state[i];

    // The preimage is 84 bytes, so the nonce's low 8 are message bytes 76..83.
    // Byte b lands in lane b/8 at position b%8, little-endian, which splits them
    // across lane 9's high half and lane 10's low half once byte-reversed.
    u64 swapped = bswap64(nonce);
    st[9]  |= (swapped & 0x00000000ffffffffULL) << 32;
    st[10] |= (swapped >> 32);

    keccak_f(st);

    // Digest is the first 32 bytes of the squeezed state: lanes 0..3,
    // little-endian. Read back as big-endian words to compare against the target.
    u32 d[8];
    for (int i = 0; i < 4; i++) {
        u64 sw = bswap64(st[i]);
        d[2 * i]     = (u32)(sw >> 32);
        d[2 * i + 1] = (u32)(sw & 0xffffffffULL);
    }

    for (int i = 0; i < 8; i++) {
        if (d[i] < limit[i]) break;
        if (d[i] > limit[i]) return;
    }

    u32 slot = atomicAdd(hit_count, 1u);
    if (slot < MAX_HITS) {
        hits[slot].nonce_lo = (u32)(nonce & 0xffffffffULL);
        hits[slot].nonce_hi = (u32)(nonce >> 32);
        for (int i = 0; i < 8; i++) hits[slot].digest[i] = d[i];
    }
}
