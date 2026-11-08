// Shared child-process selector for the embedded Android DSH MCP toolboxes.
// App-private native binaries and scripts cannot reliably be execve'd directly
// from an Android app UID. Route them through the existing system-shell/linker
// bridge while leaving normal desktop/Termux invocations unchanged.
import { resolve, isAbsolute } from 'node:path'

function inside(path, root) {
 const dir=String(root||'').replace(/\/+$/,'')
 return Boolean(dir) && path.startsWith(dir+'/')
}

export function androidToolLaunch(command, args=[], env=process.env) {
 const prefix=env.TERMUX__PREFIX||env.PREFIX||''
 const direct={command,args,bridged:false}
 if(!prefix) return direct

 const home=env.HOME||''
 const privateBinary=isAbsolute(command)&&(inside(command,prefix)||inside(command,home))
 const standalone=env.DSH_ANDROID_STANDALONE==='1'
 if(!standalone&&!privateBinary) return direct
 // Android's own executables already have an executable system mount.
 // Do not recursively re-wrap the shell used to launch our bridge.
 if(command.startsWith('/system/')||command.startsWith('/apex/')) return direct

 const bridge=env.DSH_ANDROID_EXEC_BRIDGE||
   resolve(prefix,'libexec/dsh-mobile/android-exec.sh')
 // Preserve every argument boundary; no shell interpolation is involved.
 // In standalone mode the bridge resolves bare commands from the same PATH
 // as the MCP process (including embedded Termux native tools).
 return {command:'/system/bin/sh',args:[bridge,command,...args],bridged:true}
}
