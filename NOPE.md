# NOPE — Things That Don't Work / Dead Ends

A record of approaches that were tried and definitively failed. Save yourself the time.

## 1. Nested KVM on Apple Silicon via Lima (ANY backend)

**Don't try**: Running Firecracker inside a Lima VM on macOS Apple Silicon.

Neither `vz` (Apple Virtualization.framework) nor `qemu` with `nestedVirtualization: true` provides a working `/dev/kvm` to the guest. The device node may exist but returns `ENODEV` when opened. QEMU on Apple Silicon doesn't emulate ARM virtualization extensions for aarch64 guests. This is a fundamental limitation — no amount of kernel config or Lima flags will fix it.

**Instead**: Use a real Linux server with bare-metal KVM (or a cloud VM with nested virt enabled, e.g., GCP N2/N2D, AWS metal instances, Hetzner dedicated).

## 2. mknod /dev/kvm as a workaround

**Don't try**: `sudo mknod /dev/kvm c 10 232` inside a Lima VM.

This creates the device file but the kernel driver behind it (major 10, minor 232) is non-functional because the CPU doesn't have the virtualization extensions. Opening the device returns `ENODEV (errno 19)`. The kernel's KVM module is compiled in (`CONFIG_KVM=y`) but the hardware backing isn't there.

## 3. Lima firecracker instance (qemu backend)

**Don't use**: The `firecracker` Lima instance we created with `vmType: qemu`.

It was created specifically to try nested virtualization. It doesn't work (see #1). The `default` Lima instance (vz) is faster and more stable for everything else. The `firecracker` instance can be deleted:

```bash
limactl stop firecracker
limactl delete firecracker
```

## 4. Phase 3 — FlySpriteProvider

**Skipped**: Not being built. The stub exists at `src/sandbox/backends/sprite.rs` and `src/sandbox/sprite/` but returns `Unsupported` for everything. Don't invest time here.

## 5. Firecracker without KVM

**Not possible**: Firecracker hard-requires `/dev/kvm`. There is no userspace emulation mode, no TCG fallback, no `--no-kvm` flag. If you don't have KVM, you don't have Firecracker. Alternatives for non-KVM environments:
- `DangerousHostProvider` (process-level isolation, no VM)
- Docker/container backend (not yet built but would be a reasonable middle ground)
- gVisor (would need a new backend)

## 6. Firecracker snapshot restore without re-provisioning

**Not yet working**: `FirecrackerHandle::restore()` returns `Unsupported`. Restoring a Firecracker snapshot requires stopping the current FC process and starting a fresh one that loads the snapshot. This requires re-provisioning logic that hasn't been automated yet. Checkpoints (creating snapshots) work, but restoring them is manual.

## 7. Streaming exec over SSH to Firecracker guest

**Not yet working**: `FirecrackerHandle::exec_stream()` returns `Unsupported`. Streaming exec requires maintaining a persistent SSH channel with multiplexed stdout/stderr/stdin, which is complex over the SSH command-line tool. Would need an SSH library (like `russh`) or a custom agent binary inside the guest VM.

## 8. Port exposure for Firecracker VMs

**Not yet working**: `expose_port()` / `unexpose_port()` return `Unsupported`. Would need iptables DNAT rules or SSH tunnel forwarding. Not yet implemented.
