# Structured Result Contract Repair Design

## Problem

The progressive knowledge changes made `payload` mandatory in the `ai_devflow_report_result` tool schema while host validation simultaneously forbids a payload for `task_execution`. A development expert therefore cannot produce a result accepted by both boundaries.

The full Electron startup flow reproduces the failure deterministically:

1. Project import, iteration creation, requirement creation, task creation, and task start succeed.
2. The development expert calls `ai_devflow_report_result` with the valid task-execution fields and no payload.
3. The tool boundary rejects or fails to record that result because `payload` is required.
4. Provider routing retries, eventually reports the misleading aggregate error `所有已配置 AI 服务暂时不可用，请稍后重试`, and returns the task to `ready` after three attempts.

## Contract

The tool transport accepts an optional `payload` because one result kind intentionally has no domain payload. The host remains authoritative and enforces the discriminated contract:

- `task_execution`: `payload` must be absent.
- `task_review`: `payload.kind` must be `task_review` and include `review` plus `knowledgeAssessment`.
- Knowledge and iteration result kinds: `payload` is required and its `kind` must match the requested result kind.

Making the transport property optional does not weaken domain validation. It only makes the transport schema capable of representing every valid host-side result.

## Agent Guidance

The tester profile must state the exact `task_review` payload shape. The review prompt may reinforce that contract, but the stable role policy is the primary source because all tester runs use it.

The development profile continues to omit payload for `task_execution`.

## Test Provider

The Electron E2E fake provider must model both execution phases:

- Development calls return the common result fields with no payload.
- Review calls return `REVIEW_VERDICT: PASS` and a valid `task_review` payload whose knowledge assessment is `none` with non-empty reason and evidence.

The fake provider may distinguish review requests using the review prompt already present in the request messages. It must not bypass Pi or inject state through Electron internals.

## Default Branch Finding

The separate `main` versus `master` metadata defect remains valid but is not the startup-flow root cause. The already approved default-branch recovery design remains in scope as a secondary repair and retains its own tests.

## Verification

- A focused schema test proves a task-execution report without payload is accepted by the tool transport shape.
- Existing host validation tests continue proving that task execution rejects a payload and non-task result kinds require the correct payload.
- Pi runner tests cover valid task execution and task review results.
- The complete Electron E2E flow must advance the started task to `in_review` and continue through the remaining UI checks.
- Scheduler and Desktop typechecks and focused regression suites must pass.

