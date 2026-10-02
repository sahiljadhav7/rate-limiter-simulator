# Ratescale

A teaching simulator that runs identical seeded traffic through different rate limiters side by side, to show why each design behaves the way it does under load.

## Setup

**Scenario**:
A single lesson: the shared traffic, the Backend, and the Variants being compared on it.
_Avoid_: preset, demo, experiment

**Variant**:
One Limiter and Retry Policy configuration inside a Scenario, run on the Scenario's shared traffic.
_Avoid_: panel (the Panel is only its on-screen view), lane, run

## Traffic

**Request**:
A caller's logical intent to get one thing done. It ends as a success or a failure, however many Attempts that takes.
_Avoid_: call, job

**Attempt**:
One pass of a Request through the Limiter. A Request has between one and `maxAttempts` Attempts; every retry is a new Attempt of the same Request.
_Avoid_: arrival, try, retry (as a noun for the Attempt itself), original

**Client**:
One caller identity that sends Requests and is the key the Limiter counts against when limits are per client.
_Avoid_: user, tenant, caller, consumer

**Retry Policy**:
The rule deciding whether and when a Request makes another Attempt after one is rejected, times out, or is shed. One Retry Policy applies to every Client in a Variant.
_Avoid_: client policy, backoff strategy

## Limiting

**Limiter Decision**:
The Limiter's answer for one Attempt: **Allow**, **Reject**, or **Delay** (hold the Attempt and release it at a later time).
_Avoid_: verdict, result

**Backend**:
The simulated service behind the Limiter, with a fixed number of slots and a bounded queue.
_Avoid_: server, upstream, service

**Node**:
One instance of a Limiter in the distributed scenario, each with its own view of the count.
_Avoid_: server, replica, instance

## Load

**Demand**:
New Requests per second, before any retries. It is what the rate control sets.
_Avoid_: original load, traffic setting, request rate

**Offered Load**:
Attempts per second reaching the Limiter, retries included.
_Avoid_: attempt rate, incoming load

**Retry Amplification**:
Offered Load divided by Demand: how much extra traffic retries add.

**Goodput**:
Requests that Succeeded, per second.
_Avoid_: success rate, useful throughput

**Wasted Work**:
Backend time spent on Attempts that had already timed out; their responses are discarded.
_Avoid_: zombie requests, orphaned work

## Outcomes

**Succeeded**:
A Request whose latest Attempt got a response from the Backend before that Attempt timed out.

**Rejected**:
A Request whose last Attempt was rejected by the Limiter, after which the Retry Policy gave up or ran out of Attempts.
_Avoid_: throttled, limited

**Timed out**:
A Request whose last Attempt got no response within the client timeout, after which the Retry Policy gave up or ran out of Attempts. Each Attempt has its own timeout.
_Avoid_: abandoned (as a Request outcome), expired

**Shed**:
A Request whose last Attempt was dropped because the Backend queue was full.
_Avoid_: dropped, overflowed

**Failed**:
Any Request that ended Rejected, Timed out, or Shed.

## Diagnosis

**Failure Mode**:
A named way the simulated system goes wrong, such as a retry storm or a queue overflow. Each is either a Cause or a Symptom.

**Cause**:
A Failure Mode that describes a design mistake, such as a missing backoff or a limit set too loose.

**Symptom**:
A Failure Mode that describes a consequence visible at the Backend, such as saturation or a goodput collapse.
_Avoid_: effect

**Finding**:
One detected occurrence of a Failure Mode in a Variant, with the measured evidence that triggered it.
_Avoid_: alert, issue, diagnosis (for a single one)

**Root Cause**:
The single Finding a diagnosis names as the origin; every other Finding is **Contributing**.
_Avoid_: primary, downstream

**Fix**:
A suggested configuration change for a Finding, given as a step the student can take.
_Avoid_: remedy, patch (as a domain term)
