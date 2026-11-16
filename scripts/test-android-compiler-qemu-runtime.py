#!/usr/bin/env python3
"""Compile/QEMU archive contracts independent of native-Android execution."""
import ast
import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parent.parent
def source(name):
    return (ROOT/name).read_text()

class DeveloperRuntimeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree=ast.parse(source("scripts/ci-assemble-github-runtime.py"))
        cls.values={}
        for stmt in tree.body:
            if isinstance(stmt,ast.Assign):
                for target in stmt.targets:
                    if isinstance(target,ast.Name) and target.id in ("SEEDS","TOOL_SEEDS","TOOL_COMMANDS"):
                        cls.values[target.id]=ast.literal_eval(stmt.value)

    def test_native_packages(self):
        for name in ("clang","make","cmake","ninja","lld","llvm","pkg-config","qemu-user-x86-64"):
            self.assertIn(name,self.values["TOOL_SEEDS"])
        self.assertIn("python-pip",self.values["SEEDS"])

    def test_compiler_executables_and_emulator(self):
        names=("clang","clang++","make","cmake","ninja","ld.lld","pkg-config","qemu-x86_64")
        for name in names:
            self.assertIn(name,self.values["TOOL_COMMANDS"])
        self.assertIn("missing libc development headers",source("scripts/ci-assemble-github-runtime.py"))
        self.assertIn("C toolchain missing Clang/LLVM",source("scripts/ci-assemble-github-runtime.py"))

    def test_compatibility_aliases_and_runtime_health(self):
        source_builder=source("scripts/ci-assemble-github-runtime.py")
        archive=source("scripts/ci-validate-runtime.py")
        for alias in ("cc","c++","gcc","g++"):
            self.assertIn('("'+alias+'",',source_builder)
            self.assertIn("'usr/bin/"+alias+"'",archive)
        for command in ("clang","clang++","make","cmake","ninja","ld.lld","pkg-config","qemu-x86_64"):
            self.assertIn("'usr/bin/"+command+"'",archive)

    def test_lua_lsp_runtime_launcher(self):
        import importlib.util
        import tempfile
        spec=importlib.util.spec_from_file_location(
            "dsh_ci_runtime",ROOT/"scripts/ci-assemble-github-runtime.py")
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIn("lua-language-server",module.TOOL_SEEDS)
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)/"stage"
            native=root/"usr/share/lua-language-server/bin/lua-language-server"
            native.parent.mkdir(parents=True)
            header=bytearray(20)
            header[:4]=b"\x7fELF"
            header[18:20]=(183).to_bytes(2,"little")
            native.write_bytes(header)
            module.install_lua_language_server_launcher(root)
            launcher=root/"usr/bin/lua-language-server"
            shell=launcher.read_text()
            self.assertIn("#!/system/bin/sh",shell)
            self.assertIn("/system/bin/linker64",shell)
            self.assertIn('TERMUX__PREFIX',shell)
            self.assertNotIn("/data/data/com.termux",shell)
            self.assertIn("/system/bin/rm",shell)

    def test_bundled_python_language_server(self):
        builder=source("scripts/ci-assemble-github-runtime.py")
        validator=source("scripts/ci-validate-runtime.py")
        self.assertIn('"pyright@1.1.414"',builder)
        self.assertIn('install_pyright(stage, workspace)',builder)
        self.assertIn('usr/lib/dsh-dev-tools/node_modules/pyright/langserver.index.js',validator)
        lsp=source("scripts/dsh-workspace-lsp.mjs")
        self.assertIn("bundledPyright",lsp)
        self.assertIn("'--stdio'",lsp)

    def test_android_noexec_bridge_and_capability_policy(self):
        bridge=source("scripts/dsh-android-exec.sh")
        self.assertIn("/system/bin/linker64",bridge)
        self.assertIn("DSH_ANDROID_EXEC_NOT_FOUND",bridge)
        self.assertIn("CAP_NET_RAW",source("docs/DSH_ANDROID_DEVELOPER_RUNTIME.md"))
        self.assertIn("pip",source("docs/DSH_ANDROID_DEVELOPER_RUNTIME.md"))

if __name__=="__main__":
    unittest.main()
