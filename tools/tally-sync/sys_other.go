//go:build !windows

package main

// Stand-ins so the program can be tested on Linux; the real ones are in sys_windows.go.
func openConsole(string)                 {}
func protect(d []byte) ([]byte, error)   { return append([]byte("T:"), d...), nil }
func unprotect(d []byte) ([]byte, error) { return d[2:], nil }
func selfInstall() (string, error)       { return exeTarget(), nil }
func makeTask(string) error              { return nil }
func makeShortcut(string)                {}
func uninstall()                         {}
