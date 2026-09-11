# Namespace isolation upgrade

No schema migration or index rebuild is required. Existing `namespaceStr`,
`namespacePath`, and configured index names are unchanged.

New writes (including direct batch writes) reject `/` inside namespace labels,
because the store uses `/` to join labels for uniqueness and vector filtering.
This is a breaking validation change. Colons and dollar signs remain supported.

Existing slash-containing records remain readable and deletable by their exact
namespace arrays. Rename those namespaces to slash-free labels before writing
updates. Coordinate renaming with application owners; the store does not rewrite
data automatically. Upgrade every writer to prevent new ambiguous records.

Vector searches verify candidates against the original namespace array, so
legacy encoding collisions cannot return another namespace's values. Since this
check runs after vector candidate selection, collisions can cause short pages
or fewer results; removing legacy slash labels restores candidate precision.
Legacy collisions in the existing unique index can also reject otherwise valid
new writes with duplicate-key errors until the conflicting records are renamed.
An empty search prefix still intentionally searches all namespaces.

Namespace listing treats labels as literal aggregation values, including `$`.
