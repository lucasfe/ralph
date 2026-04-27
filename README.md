# @lucasfe/ralph

Ralph is an autonomous loop that picks the next open GitHub issue, asks Claude Code to resolve it, opens a pull request, and waits for the merge — then moves on to the next one. This package extracts the in-repo Ralph scripts into a reusable CLI so any project can opt in with a single `npx @lucasfe/ralph` invocation.

This is an early alpha skeleton; subcommands and configuration will land in subsequent slices.
