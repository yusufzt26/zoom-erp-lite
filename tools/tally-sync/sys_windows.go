//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	crypt32       = syscall.NewLazyDLL("crypt32.dll")
	pAllocConsole = kernel32.NewProc("AllocConsole")
	pSetTitle     = kernel32.NewProc("SetConsoleTitleW")
	pSetOutCP     = kernel32.NewProc("SetConsoleOutputCP")
	pLocalFree    = kernel32.NewProc("LocalFree")
	pProtect      = crypt32.NewProc("CryptProtectData")
	pUnprotect    = crypt32.NewProc("CryptUnprotectData")
)

// The program has no window of its own (so the 5-minute task never flashes one); when a person opens it, give it a console.
func openConsole(title string) {
	pAllocConsole.Call()
	pSetOutCP.Call(65001)
	if t, err := syscall.UTF16PtrFromString(title); err == nil {
		pSetTitle.Call(uintptr(unsafe.Pointer(t)))
	}
	if f, err := os.OpenFile("CONIN$", os.O_RDWR, 0); err == nil {
		os.Stdin = f
	}
	if f, err := os.OpenFile("CONOUT$", os.O_RDWR, 0); err == nil {
		os.Stdout, os.Stderr = f, f
	}
}

type blob struct {
	n uint32
	p *byte
}

func newBlob(d []byte) *blob {
	if len(d) == 0 {
		return &blob{}
	}
	return &blob{n: uint32(len(d)), p: &d[0]}
}
func (b *blob) bytes() []byte {
	out := make([]byte, b.n)
	copy(out, unsafe.Slice(b.p, b.n))
	return out
}

const cryptprotectUIForbidden = 0x1

// Windows DPAPI: only this Windows user on this PC can read the saved key
func protect(d []byte) ([]byte, error) {
	var out blob
	r, _, err := pProtect.Call(uintptr(unsafe.Pointer(newBlob(d))), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFree.Call(uintptr(unsafe.Pointer(out.p)))
	return out.bytes(), nil
}
func unprotect(d []byte) ([]byte, error) {
	var out blob
	r, _, err := pUnprotect.Call(uintptr(unsafe.Pointer(newBlob(d))), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFree.Call(uintptr(unsafe.Pointer(out.p)))
	return out.bytes(), nil
}

func hidden(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return c
}

// copy this exe into the install folder (unless it already runs from there)
func selfInstall() (string, error) {
	me, err := os.Executable()
	if err != nil {
		return "", err
	}
	dst := exeTarget()
	if a, _ := filepath.Abs(me); strings.EqualFold(a, dst) {
		return dst, nil
	}
	os.MkdirAll(filepath.Dir(dst), 0o700)
	src, err := os.Open(me)
	if err != nil {
		return "", err
	}
	defer src.Close()
	tmp := dst + ".new"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	os.Remove(dst)
	return dst, os.Rename(tmp, dst)
}

func makeTask(exe string) error {
	out, err := hidden("schtasks", "/Create", "/F", "/TN", taskName, "/SC", "MINUTE", "/MO", "5", "/TR", `"`+exe+`" --once`).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func shortcutPath() string {
	return filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "ZT Tally Sync.lnk")
}

func makeShortcut(exe string) {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	ps := "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + q(shortcutPath()) + ");$s.TargetPath=" + q(exe) + ";$s.Description='ZT-ERP LITE Tally sync status';$s.Save()"
	hidden("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps).Run()
}

func uninstall() {
	hidden("schtasks", "/Delete", "/TN", taskName, "/F").Run()
	os.Remove(shortcutPath())
	dir := installDir()
	for _, f := range []string{cfgPath(), lastPath(), logPath(), filepath.Join(dir, "sync.lock")} {
		os.Remove(f)
	}
	// the exe cannot delete itself while running: remove the folder a few seconds after this closes
	c := hidden("cmd", "/C", "ping -n 4 127.0.0.1 >nul & rmdir /S /Q \""+dir+"\"")
	c.Start()
}
