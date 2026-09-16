// Copyright 2026 Commit Defender contributors. SPDX-License-Identifier: Apache-2.0
// Fixed, versioned Win32 primitives. No command language or secret-bearing argv.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed class Failure : Exception {
    internal string Code;
    internal Failure(string code) { Code = code; }
}

internal static class Native {
    internal const string Version = "1.0.3";
    const int Limit = 36 * 1024 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer {
        MaxJsonLength = Limit, RecursionLimit = 32
    };
    static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
    static readonly object OutputLock = new object();

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        internal int Length;
        internal IntPtr Descriptor;
        internal int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential {
        internal uint Flags, Type;
        internal string Target, Comment;
        internal long Written;
        internal uint Size;
        internal IntPtr Blob;
        internal uint Persist, Count;
        internal IntPtr Attributes;
        internal string Alias, User;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct FileInfo {
        internal uint Attributes;
        internal long Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits {
        internal long PerProcess, PerJob;
        internal uint Flags;
        internal UIntPtr Min, Max;
        internal uint Active;
        internal UIntPtr Affinity;
        internal uint Priority, Scheduling;
        internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes,
            OtherBytes;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool CredRead(string target, uint type, uint flags,
        out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr value);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(SafeFileHandle handle, uint type,
        uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl,
        out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access,
        uint sharing, IntPtr security, uint creation, uint flags,
        IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreatePrivateFile(string name, uint access,
        uint sharing, ref SecurityAttributes security, uint creation,
        uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool CreateDirectory(string name,
        ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool MoveFileEx(string source, string target, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern bool CreateHardLink(string target, string source,
        IntPtr security);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int info,
        ref JobLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int info,
        IntPtr data, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode,
        uint pipeMode, uint instances, uint output, uint input, uint timeout,
        ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,
        out uint processId);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access,
        out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CancelIoEx(SafePipeHandle pipe, IntPtr overlapped);

    const int PipeLimit = 9 * 1024 * 1024;
    static string PipeName(IDictionary<string, object> input) {
        string name = Text(input, "name");
        if (!System.Text.RegularExpressions.Regex.IsMatch(name,
            @"\Agcr-service-v1-[a-f0-9]{64}\z"))
            throw new Failure("invalid-request");
        return name;
    }
    static byte[] PipeFrame(Stream stream) {
        using (MemoryStream frame = new MemoryStream()) {
            byte[] buffer = new byte[8192];
            for (;;) {
                int length = stream.Read(buffer, 0, buffer.Length);
                if (length == 0) throw new IOException();
                if (frame.Length + length > PipeLimit)
                    throw new Failure("service-capacity");
                int end = Array.IndexOf(buffer, (byte)10, 0, length);
                if (end >= 0 && end != length - 1)
                    throw new Failure("service-invalid");
                frame.Write(buffer, 0, length);
                if (end >= 0) return frame.ToArray();
            }
        }
    }
    static void CancelPipe(NamedPipeServerStream pipe) {
        try { CancelIoEx(pipe.SafePipeHandle, IntPtr.Zero); }
        catch (ObjectDisposedException) { }
    }
    static NamedPipeServerStream CreateServicePipe(string name, bool first) {
        // Apply the DACL at creation, never after accepting a connection.
        RawSecurityDescriptor sd = new RawSecurityDescriptor(
            "O:" + Sid + "G:" + Sid + "D:P(A;;GA;;;" + Sid + ")");
        byte[] bytes = new byte[sd.BinaryLength];
        sd.GetBinaryForm(bytes, 0);
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            SecurityAttributes security = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                Descriptor = pinned.AddrOfPinnedObject()
            };
            // Duplex, overlapped, first-instance protection; local clients only.
            SafePipeHandle handle = CreateNamedPipe(@"\\.\pipe\" + name,
                3u | 0x40000000u | (first ? 0x80000u : 0),
                8, 8, 65536, 65536, 30000, ref security);
            if (handle.IsInvalid) {
                handle.Dispose();
                throw new Failure("service-unavailable");
            }
            try { return new NamedPipeServerStream(
                PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        } finally { pinned.Free(); }
    }
    static void PipeServer(IDictionary<string, object> input) {
        string name = PipeName(input);
        var pipes = new List<NamedPipeServerStream>();
        var pending = new Dictionary<int, TaskCompletionSource<byte[]>>();
        object gate = new object();
        var drained = new ManualResetEventSlim(true);
        bool stopping = false;
        int sequence = 0;
        try {
            for (int i = 0; i < 8; i++)
                pipes.Add(CreateServicePipe(name, i == 0));
            foreach (NamedPipeServerStream pipe in pipes) {
                Task.Factory.StartNew(() => {
                    while (!Volatile.Read(ref stopping)) {
                        int id = 0;
                        try {
                            pipe.WaitForConnection();
                            using (var timeout = new Timer(
                                _ => CancelPipe(pipe), null, 30000,
                                Timeout.Infinite)) {
                                var elapsed = Stopwatch.StartNew();
                                byte[] frame = PipeFrame(pipe);
                                id = Interlocked.Increment(ref sequence);
                                if (id <= 0) throw new Failure("service-capacity");
                                var reply = new TaskCompletionSource<byte[]>();
                                lock (gate) {
                                    pending.Add(id, reply);
                                    drained.Reset();
                                }
                                Emit(new { id, bytes = Convert.ToBase64String(frame) });
                                int remaining = (int)Math.Max(
                                    1, 30000 - elapsed.ElapsedMilliseconds);
                                if (!reply.Task.Wait(remaining))
                                    throw new TimeoutException();
                                byte[] result = reply.Task.Result;
                                pipe.Write(result, 0, result.Length);
                                pipe.Flush();
                                // DisconnectNamedPipe can discard unread bytes.
                                // The client acknowledges receipt before reuse.
                                if (result.Length > 0 && pipe.ReadByte() != 6)
                                    throw new IOException();
                            }
                        } catch (IOException) {
                            // A disconnected or deadline-cancelled client owns no job.
                        } catch (TimeoutException) {
                        } catch (Failure) {
                        } catch (ObjectDisposedException) {
                            if (!Volatile.Read(ref stopping)) throw;
                        } finally {
                            lock (gate) {
                                if (id != 0) pending.Remove(id);
                                if (pending.Count == 0) drained.Set();
                            }
                            if (!Volatile.Read(ref stopping)) {
                                try { if (pipe.IsConnected) pipe.Disconnect(); }
                                catch (IOException) { }
                            }
                        }
                    }
                }, TaskCreationOptions.LongRunning).ContinueWith(task => {
                    if (task.IsFaulted && !Volatile.Read(ref stopping)) {
                        Emit(new { error = "service-unavailable" });
                        Environment.Exit(1);
                    }
                });
            }
            Emit(new { ready = true });
            for (;;) {
                var reply = ReadInput();
                if (reply == null) return;
                int id = Number(reply, "id");
                byte[] bytes = Convert.FromBase64String(Text(reply, "bytes"));
                if (bytes.Length > PipeLimit || bytes.Length == 0 ||
                    bytes[bytes.Length - 1] != 10)
                    throw new Failure("service-invalid");
                lock (gate) {
                    TaskCompletionSource<byte[]> waiter;
                    // A timed-out peer may have disconnected before dispatch ended.
                    if (pending.TryGetValue(id, out waiter))
                        waiter.TrySetResult(bytes);
                }
            }
        } finally {
            Volatile.Write(ref stopping, true);
            lock (gate)
                foreach (var waiter in pending.Values)
                    waiter.TrySetResult(new byte[0]);
            // Flush already queued stop replies before disposing their handles.
            drained.Wait(1000);
            foreach (var pipe in pipes) {
                CancelPipe(pipe);
                pipe.Dispose();
            }
        }
    }
    static object PipeCall(IDictionary<string, object> input) {
        string name = PipeName(input);
        int timeout = Number(input, "timeout");
        byte[] bytes = Convert.FromBase64String(Text(input, "bytes"));
        if (timeout < 1 || timeout > 600000 || bytes.Length > PipeLimit)
            throw new Failure("invalid-request");
        try {
            using (var pipe = new NamedPipeClientStream(".", name,
                PipeDirection.InOut, PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification)) {
                pipe.Connect(timeout);
                uint pid;
                Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid),
                    "service-denied");
                IntPtr process = OpenProcess(0x1000, false, pid), token;
                Check(process != IntPtr.Zero, "service-denied");
                try {
                    Check(OpenProcessToken(process, 8, out token), "service-denied");
                    try {
                        using (var identity = new WindowsIdentity(token))
                            Check(identity.User.Value == Sid, "service-denied");
                    } finally { CloseHandle(token); }
                } finally { CloseHandle(process); }
                using (var timer = new Timer(_ => {
                    try { CancelIoEx(pipe.SafePipeHandle, IntPtr.Zero); }
                    catch (ObjectDisposedException) { }
                }, null, timeout, Timeout.Infinite)) {
                    pipe.Write(bytes, 0, bytes.Length);
                    pipe.Flush();
                    byte[] reply = PipeFrame(pipe);
                    pipe.WriteByte(6);
                    pipe.Flush();
                    return new { bytes = Convert.ToBase64String(reply) };
                }
            }
        } catch (UnauthorizedAccessException) {
            throw new Failure("service-denied");
        } catch (IOException) {
            throw new Failure("service-unavailable");
        } catch (TimeoutException) {
            throw new Failure("service-unavailable");
        }
    }

    static string Text(IDictionary<string, object> input, string key) {
        object value;
        if (!input.TryGetValue(key, out value) || !(value is string))
            throw new Failure("invalid-request");
        return (string)value;
    }
    static int Number(IDictionary<string, object> input, string key) {
        object value;
        if (!input.TryGetValue(key, out value) || !(value is int))
            throw new Failure("invalid-request");
        return (int)value;
    }
    static void Emit(object value) {
        lock (OutputLock) {
            Console.Out.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }
    }
    static void Check(bool success, string code) {
        if (!success) throw new Failure(code);
    }
    static string FullPath(string input) {
        input = input.Replace('/', '\\');
        // Excludes UNC, devices, ADS, relative paths and Win32 name aliases.
        if (!System.Text.RegularExpressions.Regex.IsMatch(input,
            @"^[A-Za-z]:\\") || input.Substring(2).Contains(":"))
            throw new Failure("insecure-storage");
        string result = Path.GetFullPath(input);
        foreach (string part in result.Substring(3).Split('\\')) {
            if (part.EndsWith(".") || part.EndsWith(" "))
                throw new Failure("insecure-storage");
        }
        DriveInfo drive = new DriveInfo(Path.GetPathRoot(result));
        if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS")
            throw new Failure("unsupported-platform");
        return result.TrimEnd('\\');
    }
    static FileInfo Info(SafeFileHandle handle, bool directory) {
        FileInfo info;
        Check(GetFileInformationByHandle(handle, out info),
            "storage-unavailable");
        if ((info.Attributes & 0x400) != 0 ||
            ((info.Attributes & 0x10) != 0) != directory)
            throw new Failure("insecure-storage");
        return info;
    }
    // Inputs have already passed the local absolute NTFS path checks. Use the
    // extended namespace only at the OS boundary, without changing global policy.
    static string WinPath(string path) { return @"\\?\" + path; }
    static void Private(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl,
            out sacl, out descriptor) != 0)
            throw new Failure("insecure-storage");
        try {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            RawSecurityDescriptor sd = new RawSecurityDescriptor(bytes, 0);
            if (sd.Owner == null || sd.Owner.Value != Sid ||
                sd.DiscretionaryAcl == null)
                throw new Failure("insecure-storage");
            bool user = false;
            foreach (GenericAce ace in sd.DiscretionaryAcl) {
                CommonAce rule = ace as CommonAce;
                if (rule == null || rule.IsCallback)
                    throw new Failure("insecure-storage");
                if (rule.AceQualifier != AceQualifier.AccessAllowed) continue;
                string identity = rule.SecurityIdentifier.Value;
                if (identity != Sid && identity != "S-1-5-18" &&
                    identity != "S-1-5-32-544")
                    throw new Failure("insecure-storage");
                if (identity == Sid && (rule.AccessMask & 0x1f01ff) == 0x1f01ff)
                    user = true;
            }
            if (!user) throw new Failure("insecure-storage");
        } finally { LocalFree(descriptor); }
    }
    static SafeFileHandle Open(string file, bool directory, bool privacy) {
        SafeFileHandle handle = CreateFile(WinPath(file),
            directory ? 0x20080u : 0x80020000u,
            directory ? 3u : 1u, IntPtr.Zero, 3,
            0x00200000u | (directory ? 0x02000000u : 0), IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (error == 2 || error == 3) throw new Failure("not-found");
            throw new Failure(error == 5 ? "insecure-storage" :
                "storage-unavailable");
        }
        try {
            Info(handle, directory);
            if (privacy) Private(handle);
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    static byte[] PrivateDescriptor() {
        RawSecurityDescriptor sd = new RawSecurityDescriptor(
            "O:" + Sid + "G:" + Sid + "D:P(A;OICI;FA;;;" + Sid +
            ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        byte[] bytes = new byte[sd.BinaryLength];
        sd.GetBinaryForm(bytes, 0);
        return bytes;
    }
    static void MakeDirectory(string target) {
        byte[] bytes = PrivateDescriptor();
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            SecurityAttributes attrs = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0
            };
            if (!CreateDirectory(WinPath(target), ref attrs) &&
                Marshal.GetLastWin32Error() != 183)
                throw new Failure("storage-unavailable");
        } finally { pinned.Free(); }
    }
    static FileStream NewPrivateFile(string target) {
        byte[] bytes = PrivateDescriptor();
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            SecurityAttributes attrs = new SecurityAttributes {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0
            };
            SafeFileHandle handle = CreatePrivateFile(WinPath(target), 0x40020000,
                0, ref attrs, 1, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) {
                handle.Dispose(); throw new Failure("storage-unavailable");
            }
            try {
                Private(handle);
                return new FileStream(handle, FileAccess.Write);
            } catch { handle.Dispose(); throw; }
        } finally { pinned.Free(); }
    }
    sealed class PathGuard : IDisposable {
        readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal PathGuard(string target, bool create, bool privacy) {
            try {
                string current = Path.GetPathRoot(target);
                Handles.Add(Open(current, true, false));
                string[] parts = target.Substring(3).Split('\\');
                for (int i = 0; i < parts.Length; i++) {
                    current = Path.Combine(current, parts[i]);
                    if (create) MakeDirectory(current);
                    Handles.Add(Open(current, true,
                        privacy && i == parts.Length - 1));
                }
            } catch { Dispose(); throw; }
        }
        public void Dispose() {
            for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose();
            Handles.Clear();
        }
        internal FileInfo Identity { get {
            return Info(Handles[Handles.Count - 1], true);
        } }
    }
    static object Storage(IDictionary<string, object> input, string op) {
        string target = FullPath(Text(input, "path"));
        bool directory = op == "directory" || op == "validate-directory";
        try {
        using (var guard = new PathGuard(directory ? target : Path.GetDirectoryName(target),
            op == "directory", op != "snapshot-read")) {
            if (directory) {
                FileInfo info = guard.Identity;
                return new { path = target, directoryId =
                    info.Volume.ToString("x8") + ":" +
                    info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8") };
            }
            if (op == "remove-private" || op == "replace-private") {
                try {
                    using (SafeFileHandle existing = Open(target, false, true)) {
                        // Validate ACL and reject reparse files before mutation.
                    }
                } catch (Failure error) {
                    if (error.Code != "not-found") throw;
                    if (op == "remove-private") return new { missing = true };
                }
                if (op == "remove-private") {
                    File.Delete(WinPath(target));
                    return new { removed = true };
                }
            }
            if (op == "publish" || op == "replace-private") {
                byte[] bytes = Convert.FromBase64String(Text(input, "bytes"));
                if (bytes.Length > 24 * 1024 * 1024)
                    throw new Failure("record-too-large");
                string temporary = Path.Combine(Path.GetDirectoryName(target),
                    ".pending-" + Guid.NewGuid());
                try {
                    using (FileStream stream = NewPrivateFile(temporary)) {
                        Private(stream.SafeFileHandle);
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                    }
                    // Ancestor handles remain pinned during same-volume publication.
                    uint flags = op == "replace-private" ? 9u : 8u;
                    if (!MoveFileEx(WinPath(temporary), WinPath(target), flags)) {
                        int error = Marshal.GetLastWin32Error();
                        if (op == "publish" && (error == 80 || error == 183))
                            return new { published = false };
                        throw new Failure("commit-unknown");
                    }
                    return new { published = true };
                } finally {
                    Array.Clear(bytes, 0, bytes.Length);
                    if (File.Exists(WinPath(temporary))) File.Delete(WinPath(temporary));
                }
            }
            int maximum = Number(input, "maximum");
            if (maximum < 1 || maximum > 24 * 1024 * 1024)
                throw new Failure("record-too-large");
            try {
                using (SafeFileHandle handle = Open(target, false,
                    op != "snapshot-read"))
                using (FileStream stream = new FileStream(handle,
                    FileAccess.Read)) {
                    if (stream.Length > maximum)
                        throw new Failure("record-too-large");
                    byte[] bytes = new byte[(int)stream.Length];
                    int offset = 0;
                    while (offset < bytes.Length) {
                        int count = stream.Read(bytes, offset, bytes.Length - offset);
                        if (count == 0) throw new Failure("corrupt-storage");
                        offset += count;
                    }
                    return new { bytes = Convert.ToBase64String(bytes) };
                }
            } catch (Failure error) {
                if (error.Code == "not-found") return new { missing = true };
                throw;
            }
        }
        } catch (Failure error) {
            if ((op == "read" || op == "snapshot-read") && error.Code == "not-found")
                return new { missing = true };
            throw;
        }
    }
    static object Credentials(IDictionary<string, object> input) {
        string service = Text(input, "service"), reference = Text(input, "reference");
        foreach (string value in new[] { service, reference })
            if (!System.Text.RegularExpressions.Regex.IsMatch(value,
                @"\A[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}\z"))
                throw new Failure("credential-unavailable");
        if (!service.StartsWith("com.commitdefender.", StringComparison.Ordinal))
            throw new Failure("credential-unavailable");
        string target = service + "/" + reference;
        string action = Text(input, "action");
        if (action == "remove") {
            if (!CredDelete(target, 1, 0) && Marshal.GetLastWin32Error() != 1168)
                throw new Failure("credential-unavailable");
            return new { removed = true };
        }
        if (action == "write") {
            byte[] secret = Convert.FromBase64String(Text(input, "bytes"));
            if (secret.Length < 1 || secret.Length > 2560)
                throw new Failure("credential-unavailable");
            GCHandle pinned = GCHandle.Alloc(secret, GCHandleType.Pinned);
            try {
                Credential credential = new Credential {
                    Type = 1, Target = target, Size = (uint)secret.Length,
                    Blob = pinned.AddrOfPinnedObject(), Persist = 2,
                    User = Sid
                };
                Check(CredWrite(ref credential, 0), "credential-unavailable");
                return new { written = true };
            } finally { Array.Clear(secret, 0, secret.Length); pinned.Free(); }
        }
        if (action != "read") throw new Failure("invalid-request");
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) {
            if (Marshal.GetLastWin32Error() == 1168) return new { missing = true };
            throw new Failure("credential-unavailable");
        }
        try {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer,
                typeof(Credential));
            if (credential.Size < 1 || credential.Size > 2560)
                throw new Failure("credential-unavailable");
            byte[] bytes = new byte[credential.Size];
            Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
            string encoded = Convert.ToBase64String(bytes);
            Array.Clear(bytes, 0, bytes.Length);
            return new { bytes = encoded };
        } finally { CredFree(pointer); }
    }
    static object AuthLink(IDictionary<string, object> input) {
        string source = FullPath(Text(input, "source"));
        string target = FullPath(Text(input, "path"));
        if (Path.GetFileName(source) != "auth.json" ||
            Path.GetFileName(target) != "auth.json")
            throw new Failure("insecure-storage");
        using (new PathGuard(Path.GetDirectoryName(source), false, false))
        using (new PathGuard(Path.GetDirectoryName(target), false, true)) {
            try {
                using (SafeFileHandle original = Open(source, false, false)) {
                    Check(CreateHardLink(WinPath(target), WinPath(source), IntPtr.Zero),
                        "credential-unavailable");
                    using (SafeFileHandle linked = Open(target, false, false)) {
                        FileInfo a = Info(original, false), b = Info(linked, false);
                        Check(a.Volume == b.Volume && a.IndexHigh == b.IndexHigh &&
                            a.IndexLow == b.IndexLow, "credential-unavailable");
                    }
                    return new { linked = true };
                }
            } catch (Failure error) {
                if (error.Code == "not-found") return new { missing = true };
                throw;
            }
        }
    }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }
    static void StopDescendants(IntPtr job) {
        // The supervisor owns the job, so terminating the whole job here would
        // lose its result. Terminate only verified members, then drain to EOF.
        const int size = 8 + 4096 * 8;
        IntPtr data = Marshal.AllocHGlobal(size);
        Stopwatch deadline = Stopwatch.StartNew();
        try {
            while (deadline.ElapsedMilliseconds < 2000) {
                uint returned;
                Check(QueryInformationJobObject(job, 3, data, size, out returned),
                    "cleanup-failed");
                int count = Marshal.ReadInt32(data, 4);
                Check(count >= 1 && count <= 4096, "cleanup-failed");
                bool remaining = false;
                for (int i = 0; i < count; i++) {
                    uint pid = (uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
                    if (pid == (uint)Process.GetCurrentProcess().Id) continue;
                    IntPtr process = OpenProcess(0x101001, false, pid);
                    if (process == IntPtr.Zero) {
                        Check(Marshal.GetLastWin32Error() == 87, "cleanup-failed");
                        continue;
                    }
                    try {
                        bool member;
                        Check(IsProcessInJob(process, job, out member), "cleanup-failed");
                        if (!member) continue;
                        if (WaitForSingleObject(process, 0) != 0) {
                            remaining = true;
                            Check(TerminateProcess(process, 125), "cleanup-failed");
                        }
                        uint remainingMs = (uint)Math.Max(1, 2000 - deadline.ElapsedMilliseconds);
                        Check(WaitForSingleObject(process, remainingMs) == 0, "cleanup-failed");
                    } finally { CloseHandle(process); }
                }
                if (!remaining) return;
            }
            throw new Failure("cleanup-failed");
        } finally { Marshal.FreeHGlobal(data); }
    }
    static object Run(IDictionary<string, object> input) {
        string command = Text(input, "command");
        if (!Path.IsPathRooted(command) ||
            !command.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new Failure("executable-unavailable");
        // Join before starting any child. The handle is never inherited.
        // Abrupt helper termination closes the job and kills every descendant.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        JobLimits limits = new JobLimits { Flags = 0x2000 };
        Check(job != IntPtr.Zero && SetInformationJobObject(job, 9, ref limits,
            (uint)Marshal.SizeOf(typeof(JobLimits))) &&
            AssignProcessToJobObject(job, GetCurrentProcess()), "cleanup-failed");
        Task.Run(() => { Console.In.ReadLine(); Environment.Exit(125); });
        ProcessStartInfo start = new ProcessStartInfo(command) {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, WorkingDirectory = Text(input, "cwd")
        };
        StringBuilder arguments = new StringBuilder();
        foreach (object item in (IEnumerable)input["args"])
            arguments.Append(Quote((string)item)).Append(' ');
        start.Arguments = arguments.ToString();
        start.EnvironmentVariables.Clear();
        foreach (KeyValuePair<string, object> pair in
            (Dictionary<string, object>)input["env"])
            start.EnvironmentVariables[pair.Key] = (string)pair.Value;
        int maximum = Number(input, "maximum"), timeout = Number(input, "timeout");
        if (maximum < 1 || maximum > 16 * 1024 * 1024 ||
            timeout < 1 || timeout > 600000)
            throw new Failure("invalid-request");
        using (Process process = new Process { StartInfo = start }) {
            Check(process.Start(), "executable-unavailable");
            int total = 0;
            object gate = new object();
            MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
            Action<Stream, MemoryStream> copy = (source, destination) => {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                    lock (gate) {
                        total += count;
                        if (total > maximum) {
                            Emit(new { error = "output-limit" });
                            Environment.Exit(1);
                        }
                        destination.Write(buffer, 0, count);
                    }
                }
            };
            Task output = Task.Run(() => copy(process.StandardOutput.BaseStream, stdout));
            Task errors = Task.Run(() => copy(process.StandardError.BaseStream, stderr));
            byte[] stdin = Encoding.UTF8.GetBytes(Text(input, "stdin"));
            Task.Run(() => {
                try {
                    process.StandardInput.BaseStream.Write(stdin, 0, stdin.Length);
                    process.StandardInput.Close();
                } catch (IOException) { }
                finally { Array.Clear(stdin, 0, stdin.Length); }
            });
            if (!process.WaitForExit(timeout)) throw new Failure("timeout");
            StopDescendants(job);
            Check(Task.WaitAll(new[] { output, errors }, 2000), "cleanup-failed");
            lock (gate) return new {
                code = process.ExitCode,
                stdout = Encoding.UTF8.GetString(stdout.ToArray()),
                stderr = Encoding.UTF8.GetString(stderr.ToArray())
            };
        }
    }
    static Dictionary<string, object> ReadInput() {
        StringBuilder text = new StringBuilder();
        int c;
        while ((c = Console.In.Read()) >= 0 && c != '\n') {
            if (text.Length >= Limit) throw new Failure("invalid-request");
            text.Append((char)c);
        }
        if (c < 0 && text.Length == 0) return null;
        lock (OutputLock)
            return Json.Deserialize<Dictionary<string, object>>(text.ToString());
    }
    static object Execute(Dictionary<string, object> input, bool storageOnly) {
        string operation = Text(input, "operation");
        if (operation == "identity") return new {
            version = Version, sid = Sid, runtime = Environment.Version.ToString(),
            dataDirectory = Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData), "CommitDefender")
        };
        if (operation == "credential") return Credentials(input);
        if (!storageOnly && operation == "auth-link") return AuthLink(input);
        if (!storageOnly && operation == "process") return Run(input);
        if (!storageOnly && operation == "pipe-call") return PipeCall(input);
        if (new List<string> { "directory", "validate-directory",
            "read", "publish", "replace-private", "remove-private",
            "snapshot-read" }.Contains(operation))
            return Storage(input, operation);
        throw new Failure("invalid-request");
    }
    public static int Main(string[] args) {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            bool session = args.Length == 2 && args[0] == "--storage-session";
            bool pipeServer = args.Length == 2 && args[0] == "--pipe-server";
            if (args.Length != 0 && !session && !pipeServer)
                throw new Failure("invalid-request");
            if (session || pipeServer) {
                int ownerId;
                if (!Int32.TryParse(args[1], out ownerId) || ownerId <= 0)
                    throw new Failure("invalid-request");
                IntPtr owner = OpenProcess(0x100000, false, (uint)ownerId);
                Check(owner != IntPtr.Zero, "storage-unavailable");
                Task.Run(() => {
                    uint result = WaitForSingleObject(owner, UInt32.MaxValue);
                    CloseHandle(owner);
                    Environment.Exit(result == 0 ? 0 : 1);
                });
            }
            for (;;) {
                var input = ReadInput();
                if (input == null) return 0;
                if (pipeServer) {
                    PipeServer(input);
                    return 0;
                }
                if (!session) {
                    Emit(Execute(input, false));
                    // Close the owning process job, including descendants.
                    Environment.Exit(0);
                    return 0;
                }
                // Each request still opens, validates and closes guarded handles.
                try { Emit(Execute(input, true)); }
                catch (Failure error) { Emit(new { error = error.Code }); }
                catch (Exception) { Emit(new { error = "storage-unavailable" }); }
            }
        } catch (Failure error) { Emit(new { error = error.Code }); }
        catch (Exception) { Emit(new { error = "storage-unavailable" }); }
        Environment.Exit(1);
        return 1;
    }
}
