# Lessons Learned — Sandbox Module

Hard-won knowledge from building the sandbox/Firecracker integration.

## 1. FsJail path canonicalization on macOS

**Problem**: `std::fs::canonicalize()` fails on non-existent paths (returns `Err`). On macOS, tempdir paths go through `/var` which is a symlink to `/private/var`. So `canonicalize("/var/folders/...")` returns `/private/var/folders/...` but `starts_with("/var/folders/...")` is false. The FsJail `resolve()` method used canonicalize to check path containment, and it broke in two ways:
1. Paths that don't exist yet can't be canonicalized
2. Symlink resolution changes the prefix, breaking `starts_with` checks

**Fix**: Don't use `canonicalize()`. Instead, manually normalize path components by resolving `.` and `..` segments. This handles both non-existent paths and symlink prefix mismatches.

**File**: `src/sandbox/local_host/fs_jail.rs`

## 2. Nested KVM does NOT work on Apple Silicon

**Problem**: Firecracker requires `/dev/kvm`. We tried two Lima VM backends on macOS Apple Silicon (M-series):

- **vz (Apple Virtualization.framework)**: `/dev/kvm` device node exists (kernel has `CONFIG_KVM=y` built-in), but opening it returns `ENODEV (errno 19)`. The CPU (`implementer: 0x61`, Apple Silicon) doesn't expose ARM virtualization extensions to the guest.
- **qemu**: Even with `nestedVirtualization: true` in Lima config, `/dev/kvm` doesn't appear at all. QEMU on Apple Silicon doesn't support nested virtualization for aarch64 guests.

**Result**: Neither Lima backend gives you working KVM on Apple Silicon. This is a fundamental hardware/hypervisor limitation, not a configuration issue.

**Solution**: Use a real Linux server (bare metal or cloud with nested virt) for Firecracker. The `RemoteSsh` transport was built for this — Cthulu on macOS talks to the FC API over TCP, host commands go over SSH.

**Evidence**:
```
# Inside Lima (vz) — device exists but doesn't work
$ ls -la /dev/kvm
crw-rw-rw- 1 root root 10, 232 ... /dev/kvm
$ python3 -c "import os; os.open('/dev/kvm', os.O_RDWR)"
OSError: [Errno 19] No such device: '/dev/kvm'

# Inside Lima (qemu + nestedVirtualization:true) — device doesn't exist
$ ls /dev/kvm
ls: cannot access '/dev/kvm': No such file or directory
```

## 3. Lima vz vs qemu — vz is the better choice for everything except KVM

The `default` Lima instance (vz) is faster, more stable, and has better macOS integration than the `firecracker` instance (qemu). The only reason to use qemu is `nestedVirtualization`, and on Apple Silicon it doesn't actually work. Stick with vz for Lima instances.

## 4. Firecracker kernel image must match guest architecture

When downloading FC kernel/rootfs images from the CI S3 bucket, make sure to get the right architecture. The S3 paths include architecture:
- `aarch64/vmlinux-6.1` for ARM64
- `x86_64/vmlinux-6.1` for Intel/AMD

Mismatched arch = instant VM crash with no useful error message.

## 5. socat for exposing Unix sockets over TCP

Firecracker only speaks Unix domain socket. To reach it from another machine (or from macOS host into a Lima VM), use socat:

```bash
socat TCP-LISTEN:8080,fork,reuseaddr UNIX-CONNECT:/tmp/firecracker.sock
```

The `fork` flag is essential — without it, socat exits after the first connection. `reuseaddr` prevents "address already in use" errors on restart.

## 6. FlowRunner construction sites are spread across the codebase

Adding a field to `FlowRunner` requires updating 7 construction sites:
- 4 in `src/server/flow_routes.rs`
- 3 in `src/flows/scheduler.rs`

Missing any one causes a compile error, but it's easy to miss one during refactoring. Grep for `FlowRunner {` or `FlowRunner::new` to find them all.

## 7. AppState must derive Clone — use Arc for non-Clone fields

`AppState` must derive Clone (Axum requirement). Any non-Clone field needs to be wrapped in `Arc`. `sandbox_provider: Arc<dyn SandboxProvider>` follows this pattern.

## 8. Rust edition 2024 implications

Cargo.toml specifies `edition = "2024"`. This affects:
- `use` declarations (edition 2024 changes some import rules)
- `async_trait` is still needed since native async traits aren't fully stabilized for dyn dispatch

## 9. reqwest is already a dependency — use it

No need to add HTTP client dependencies. Cthulu already has `reqwest` in `Cargo.toml`. The FC TCP transport uses it for `PUT`/`GET`/`PATCH` against the FC REST API.

## 10. Don't try to build Firecracker inside a Lima VM for development

Building FC from source inside Lima works but is slow and painful. For the remote server approach, just download the release binary:

```bash
# On the remote Linux server
ARCH=$(uname -m)  # aarch64 or x86_64
curl -Lo firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.12.0/firecracker-v1.12.0-${ARCH}
chmod +x firecracker
sudo mv firecracker /usr/local/bin/
```
