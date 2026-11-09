//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

const title = "园区无线信号监测"
const noConsole = 0x08000000
const appIconID = 1 // RT_GROUP_ICON in rsrc_windows_amd64.syso

func messageBox(message string, flags uintptr) uintptr {
	caption, _ := syscall.UTF16PtrFromString(title)
	content, _ := syscall.UTF16PtrFromString(message)
	button, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(content)), uintptr(unsafe.Pointer(caption)), flags,
	)
	return button
}

func oneInstance() (syscall.Handle, error) {
	name, _ := syscall.UTF16PtrFromString(`Local\WlanMonitorDesktop`)
	kernel := syscall.NewLazyDLL("kernel32.dll")
	handle, _, err := kernel.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return 0, err
	}
	if err == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, errors.New("应用已在运行，请切换到已打开的窗口。")
	}
	return syscall.Handle(handle), nil
}

type backend struct {
	cmd  *exec.Cmd
	stop io.WriteCloser
	done chan struct{}
}

func (b *backend) close() {
	b.stop.Close()
	select {
	case <-b.done:
	case <-time.After(3 * time.Second):
		b.cmd.Process.Kill()
		<-b.done
	}
}

func startBackend(root string) (*backend, string, error) {
	cmd := exec.Command(filepath.Join(root, "runtime", "python.exe"), "-X", "utf8", "-u", filepath.Join(root, "app", "desktop.py"))
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noConsole}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, "", err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, "", err
	}
	child := &backend{cmd: cmd, stop: stdin, done: make(chan struct{})}
	ready := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		line, _ := reader.ReadString('\n')
		ready <- line
		io.Copy(io.Discard, reader)
		cmd.Wait()
		close(child.done)
	}()
	select {
	case line := <-ready:
		target, err := url.Parse(strings.TrimRight(line, "\r\n"))
		if err == nil && target.Scheme == "http" && target.Hostname() == "127.0.0.1" && target.Path == "/open" {
			return child, target.String(), nil
		}
	case <-time.After(12 * time.Second):
	}
	child.close()
	return nil, "", errors.New("本机采集服务无法启动。请完整解压应用，并确认当前账号可访问本机配置目录。")
}

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	handle, err := oneInstance()
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)

	version, err := webviewloader.GetInstalledVersion()
	if err != nil {
		return fmt.Errorf("无法检查 Microsoft Edge WebView2 运行环境：%w", err)
	}
	if version == "" {
		setup := filepath.Join(root, "MicrosoftEdgeWebview2Setup.exe")
		if _, err := os.Stat(setup); err != nil {
			return errors.New("此电脑缺少 Microsoft Edge WebView2。请安装后重新打开应用。")
		}
		const yes = 6
		if messageBox("此电脑需要 Microsoft Edge WebView2 才能显示应用窗口。是否打开包内 Microsoft 安装程序？安装完成后请重新打开应用。", 0x24) == yes {
			return exec.Command(setup).Start()
		}
		return nil
	}

	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	dataPath := filepath.Join(cache, "WlanMonitor", "WebView2")
	if err := os.MkdirAll(dataPath, 0700); err != nil {
		return err
	}
	view := webview.NewWithOptions(webview.WebViewOptions{
		DataPath:      dataPath,
		AutoFocus:     true,
		WindowOptions: webview.WindowOptions{Title: title, Width: 1200, Height: 850, Center: true, IconId: appIconID},
	})
	if view == nil {
		return errors.New("无法创建桌面窗口，请检查 Microsoft Edge WebView2。")
	}
	defer view.Destroy()

	child, target, err := startBackend(root)
	if err != nil {
		return err
	}
	defer child.close()
	windowClosed := make(chan struct{})
	go func() {
		select {
		case <-child.done:
			view.Terminate()
		case <-windowClosed:
		}
	}()
	view.Navigate(target)
	view.Run()
	close(windowClosed)
	select {
	case <-child.done:
		return errors.New("本机采集服务已退出，请重新打开应用。")
	default:
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		messageBox(err.Error(), 0x10)
	}
}
