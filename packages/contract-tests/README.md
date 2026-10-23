# Shared plugin contracts

`branch-names.json` contains valid and invalid release/hotfix/conflict naming cases and allowed conflict targets. Both VS Code (`test:contracts`) and IDEA (`:core:test`) execute this data against their native implementations. This directory contains data only; it is not a new runtime package or a Node service.
