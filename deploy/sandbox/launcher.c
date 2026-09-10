#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <grp.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported sandbox architecture
#endif
#define DENY_CALL(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

int main(int count, char **arguments) {
  if (count != 2 || geteuid() != 0) return 125;
  struct rlimit cpu = {25, 25};
  struct rlimit files = {0, 0};
  struct rlimit descriptors = {128, 128};
  for (int descriptor = 3; descriptor < 65536; descriptor++) close(descriptor);
  if (chdir(arguments[1]) || chroot(".") || chdir("/source")) return 125;
  if (setgroups(0, NULL) || setgid(65534) || setuid(65534)) return 125;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) return 125;
  if (setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_FSIZE, &files) || setrlimit(RLIMIT_NOFILE, &descriptors)) return 125;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY_CALL(__NR_socket), DENY_CALL(__NR_connect),
    DENY_CALL(__NR_ptrace), DENY_CALL(__NR_process_vm_readv), DENY_CALL(__NR_process_vm_writev),
    DENY_CALL(__NR_mount), DENY_CALL(__NR_umount2), DENY_CALL(__NR_unshare), DENY_CALL(__NR_setns),
    DENY_CALL(__NR_kill), DENY_CALL(__NR_bpf), DENY_CALL(__NR_keyctl), DENY_CALL(__NR_chroot),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  clearenv();
  setenv("PATH", "/usr/bin:/usr/local/bin:/bin", 1);
  setenv("HOME", "/source", 1);
  char *command[] = { "/usr/local/bin/node", "/tool.mjs", "/source", NULL };
  execv(command[0], command);
  return 125;
}
