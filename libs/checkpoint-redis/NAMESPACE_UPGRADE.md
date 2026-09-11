# Namespace matching upgrade

RedisStore now matches namespace strings through a case-sensitive JSON TAG field
named `namespace`, rather than tokenized TEXT. Search accepts the exact namespace
or descendants separated by `.`. Exact reads and mutations match only the full
namespace. Existing restrictions on periods inside labels remain in place.

Call `setup()` after upgrading, before serving traffic. It adds the TAG alias to
both configured indexes using FT.ALTER and indexes existing documents without
rewriting their JSON. Wait for background indexing to finish before relying on
complete search results. Run upgraded clients only; older clients still issue
unsafe TEXT queries even after the index is upgraded.

Search labels remain literal, including stars and punctuation. Namespace listing
supports standalone `*` as one complete segment. Redis prefix-expansion limits
still apply to descendant TAG searches; this patch does not change server search
limits or existing vector/filter pagination semantics.
