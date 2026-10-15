package com.dshmobile.shell;

import android.os.Binder;
import android.os.Parcel;
import android.os.RemoteException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Shizuku UserService instantiated by Shizuku, not an exported Android Service.
 * Runs under Shizuku's actual UID (usually ADB shell 2000; never assume root).
 * A deliberately small, read-only operation allowlist: no arbitrary shell, no
 * file mutations, no user-supplied command line.
 */
public final class ShizukuInspectorService extends Binder {
    public static final int TRANSACTION_INSPECT = Binder.FIRST_CALL_TRANSACTION;
    public static final String DESCRIPTOR = "com.dshmobile.shell.ShizukuInspectorService";
    private static final int LIMIT = 64 * 1024;

    public ShizukuInspectorService() {
        super();
        attachInterface(null, DESCRIPTOR);
    }

    @Override
    protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
        if (code != TRANSACTION_INSPECT) return super.onTransact(code, data, reply, flags);
        data.enforceInterface(DESCRIPTOR);
        String operation = data.readString();
        String packageName = data.readString();
        String result;
        try {
            result = inspect(operation, packageName).toString();
        } catch (Exception error) {
            try {
                result = new JSONObject()
                        .put("ok", false)
                        .put("error", error.getClass().getSimpleName() + ": " + error.getMessage())
                        .toString();
            } catch (org.json.JSONException jsonError) {
                result = new JSONObject().toString();
            }
        }
        if (reply != null) {
            reply.writeNoException();
            reply.writeString(result);
        }
        return true;
    }

    private JSONObject inspect(String operation, String packageName) throws Exception {
        String[] argv;
        switch (operation == null ? "" : operation) {
            case "identity":
                argv = new String[]{"/system/bin/id"};
                break;
            case "packages":
                argv = new String[]{"/system/bin/pm", "list", "packages", "-3"};
                break;
            case "processes":
                argv = new String[]{"/system/bin/ps", "-A"};
                break;
            case "package":
                if (packageName == null || !packageName.matches("[A-Za-z][A-Za-z0-9_.]{0,200}"))
                    throw new IllegalArgumentException("invalid package name");
                argv = new String[]{"/system/bin/pm", "path", packageName};
                break;
            default:
                throw new IllegalArgumentException("operation is not allowed");
        }

        Process process = new ProcessBuilder(argv).redirectErrorStream(true).start();
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        boolean overflow = false;
        try {
            InputStream stream = process.getInputStream();
            byte[] block = new byte[2048];
            int size;
            while ((size = stream.read(block)) != -1) {
                if (captured.size() + size > LIMIT) {
                    overflow = true;
                    process.destroyForcibly();
                    break;
                }
                captured.write(block, 0, size);
            }
            boolean complete = process.waitFor(6, TimeUnit.SECONDS);
            if (!complete) process.destroyForcibly();
            int code = complete ? process.exitValue() : -1;
            return new JSONObject()
                    .put("ok", complete && !overflow && code == 0)
                    .put("operation", operation)
                    .put("uid", android.os.Process.myUid())
                    .put("exitCode", code)
                    .put("timedOut", !complete)
                    .put("truncated", overflow)
                    .put("output", new String(captured.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }
}
