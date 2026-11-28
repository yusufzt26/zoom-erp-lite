// ZT-Tally-Sync: runs on the accounts PC where Tally is. Every 5 minutes it reads unpaid bills, party balances,
// receipts and payments from Tally (read-only, XML port 9000) and sends them to ZT-ERP LITE.
// It never writes anything into Tally.
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const version = "1.1.0"
const taskName = "ZT Tally Sync"
const defaultERP = "https://zoom-erp-lite.netlify.app"
const voucherDays = 90

type Config struct {
	ERP       string   `json:"erp"`
	Key       string   `json:"key"` // protected with Windows DPAPI (only this Windows user on this PC can read it)
	Tally     string   `json:"tally"`
	Companies []string `json:"companies,omitempty"` // companies seen before, so a closed company is reported, not forgotten
}

type Last struct {
	At      string `json:"at"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

func installDir() string {
	if d := os.Getenv("ZT_INSTALL_DIR"); d != "" {
		return d
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	return filepath.Join(base, "ZT-Tally-Sync")
}
func cfgPath() string  { return filepath.Join(installDir(), "config.json") }
func lastPath() string { return filepath.Join(installDir(), "last-sync.json") }
func logPath() string  { return filepath.Join(installDir(), "sync-log.txt") }
func exeTarget() string {
	return filepath.Join(installDir(), "ZT-Tally-Sync.exe")
}

func loadCfg() (*Config, error) {
	b, err := os.ReadFile(cfgPath())
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Tally == "" {
		c.Tally = "http://localhost:9000"
	}
	return c, nil
}
func saveCfg(c *Config) error {
	os.MkdirAll(installDir(), 0o700)
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(cfgPath(), b, 0o600)
}
func (c *Config) secret() (string, error) {
	raw, err := base64.StdEncoding.DecodeString(c.Key)
	if err != nil {
		return "", err
	}
	s, err := unprotect(raw)
	return string(s), err
}

func logf(format string, a ...any) {
	os.MkdirAll(installDir(), 0o700)
	p := logPath()
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 { // keep the log small: last half only
		if b, err := os.ReadFile(p); err == nil {
			os.WriteFile(p, b[len(b)/2:], 0o600)
		}
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\r\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
}

// Setup code from the ERP: ZTS1.<site address, base64url>.<secret>; a bare secret uses the default site
func parseCode(s string) (erp, secret string, err error) {
	s = strings.TrimSpace(strings.Trim(strings.TrimSpace(s), `"'`))
	if strings.HasPrefix(s, "ZTS1.") {
		p := strings.Split(s, ".")
		if len(p) != 3 {
			return "", "", errors.New("the setup code is not complete; copy it again")
		}
		u, e := base64.RawURLEncoding.DecodeString(strings.TrimRight(p[1], "="))
		if e != nil || !strings.HasPrefix(string(u), "http") {
			return "", "", errors.New("the setup code is not complete; copy it again")
		}
		return strings.TrimRight(string(u), "/"), p[2], nil
	}
	if len(s) < 20 || strings.ContainsAny(s, " \t") {
		return "", "", errors.New("that does not look like a setup code")
	}
	return defaultERP, s, nil
}

var hc = &http.Client{Timeout: 120 * time.Second}

func erpPost(erp, secret, path string, body any) (map[string]any, error) {
	b, _ := json.Marshal(body)
	var lastErr error
	for try := 0; try < 3; try++ {
		if try > 0 {
			time.Sleep(time.Duration(try*5) * time.Second)
		}
		req, _ := http.NewRequest("POST", erp+"/api/"+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-sync-key", secret)
		if h, err := os.Hostname(); err == nil {
			req.Header.Set("x-sync-pc", h)
		}
		res, err := hc.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("could not reach %s (is the internet on?)", erp)
			continue
		}
		rb, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		j := map[string]any{}
		json.Unmarshal(rb, &j)
		if res.StatusCode == 401 {
			return j, fmt.Errorf("%v", j["error"])
		}
		if res.StatusCode >= 300 {
			msg, _ := j["error"].(string)
			if msg == "" {
				msg = res.Status
			}
			lastErr = fmt.Errorf("ZT-ERP LITE answered: %s", msg)
			if res.StatusCode < 500 {
				return j, lastErr
			}
			continue
		}
		return j, nil
	}
	return nil, lastErr
}

type Payload struct {
	V         string    `json:"v"`
	At        string    `json:"at"`
	PC        string    `json:"pc"`
	User      string    `json:"user"`
	Tally     string    `json:"tally"`
	From      string    `json:"from"`
	PurFrom   string    `json:"purFrom"`
	Error     string    `json:"error,omitempty"`
	Companies []Company `json:"companies"`
}

// One sync: read Tally, send to the ERP. say() prints progress when someone is watching.
func syncOnce(c *Config, say func(string, ...any)) (string, error) {
	secret, err := c.secret()
	if err != nil {
		return "", errors.New("the saved sync key could not be read on this Windows user; run setup again")
	}
	now := time.Now()
	t := newTally(c.Tally)
	pc, _ := os.Hostname()
	p := Payload{V: version, At: now.Format(time.RFC3339), PC: pc, User: os.Getenv("USERNAME"), Tally: c.Tally, From: now.AddDate(0, 0, -voucherDays).Format("2006-01-02"), PurFrom: purFrom(now).Format("2006-01-02"), Companies: []Company{}}
	say("Reading Tally at %s ...", c.Tally)
	cos, terr := t.Companies()
	if terr != nil {
		p.Error = "Tally is not open on " + pc + ", or its port 9000 is off"
		if !errors.Is(terr, errNoTally) {
			p.Error = terr.Error()
		}
	} else if len(cos) == 0 {
		p.Error = "Tally is open but no company is loaded"
	}
	if terr == nil && len(cos) == 0 { // some Tally versions do not list companies: read the company that is open now
		if co := t.ReadCompany("", now, voucherDays); co.OK {
			co.Name = "Current company in Tally"
			say("  Company: (current company)")
			say("    %d unpaid bills, %d party ledgers, %d receipts/payments, %s", len(co.Bills), len(co.Ledgers), len(co.Vch), purSay(co))
			p.Companies, p.Error = append(p.Companies, co), ""
			cos = []string{co.Name}
		}
	}
	open := map[string]bool{}
	for _, name := range cos {
		if name == "Current company in Tally" {
			open[name] = true
			continue
		}
		open[name] = true
		say("  Company: %s", name)
		co := t.ReadCompany(name, now, voucherDays)
		if co.OK {
			say("    %d unpaid bills, %d party ledgers, %d receipts/payments, %s", len(co.Bills), len(co.Ledgers), len(co.Vch), purSay(co))
		} else {
			say("    Could not read: %s", co.Error)
		}
		p.Companies = append(p.Companies, co)
	}
	for _, name := range c.Companies {
		if !open[name] {
			p.Companies = append(p.Companies, Company{Name: name, Error: "Company not open in Tally", Ledgers: []Ledger{}, Bills: []Bill{}, Vch: []Vch{}})
		}
	}
	seen := map[string]bool{}
	var all []string
	for _, n := range append(append([]string{}, c.Companies...), cos...) {
		if !seen[n] {
			seen[n] = true
			all = append(all, n)
		}
	}
	if strings.Join(all, "\x01") != strings.Join(c.Companies, "\x01") {
		c.Companies = all
		saveCfg(c)
	}
	say("Sending to %s ...", c.ERP)
	j, err := erpPost(c.ERP, secret, "tally/push", p)
	if err != nil {
		return "", err
	}
	msg := fmt.Sprintf("sent; %v changes", j["changed"])
	if p.Error != "" {
		msg = p.Error + " (status sent to the ERP)"
		return msg, errors.New(p.Error)
	}
	nb := 0
	for _, co := range p.Companies {
		nb += len(co.Bills)
	}
	return fmt.Sprintf("OK: %d companies, %d unpaid bills, %v changes sent", len(cos), nb, j["changed"]), nil
}

func writeLast(ok bool, msg string) {
	b, _ := json.Marshal(Last{At: time.Now().Format("02-01-2006 15:04"), OK: ok, Message: msg})
	os.WriteFile(lastPath(), b, 0o600)
}

// --once: what the Windows task runs every 5 minutes, without a window
func runOnce() int {
	unlock, ok := lock()
	if !ok {
		return 0
	}
	defer unlock()
	c, err := loadCfg()
	if err != nil {
		logf("not set up: %v", err)
		return 1
	}
	msg, err := syncOnce(c, func(string, ...any) {})
	if err != nil {
		logf("ERROR %v", err)
		writeLast(false, err.Error())
		return 1
	}
	logf("%s", msg)
	writeLast(true, msg)
	return 0
}

func lock() (func(), bool) {
	os.MkdirAll(installDir(), 0o700)
	p := filepath.Join(installDir(), "sync.lock")
	if st, err := os.Stat(p); err == nil && time.Since(st.ModTime()) > 15*time.Minute {
		os.Remove(p)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, false
	}
	f.Close()
	return func() { os.Remove(p) }, true
}

var in *bufio.Reader

func ask(q string) string {
	fmt.Print(q)
	s, _ := in.ReadString('\n')
	return strings.TrimSpace(s)
}
func pause() { ask("\nPress Enter to close this window.") }

func header() {
	fmt.Println("==============================================================")
	fmt.Println("  ZT-ERP LITE  -  Tally sync for the accounts PC   (v" + version + ")")
	fmt.Println("  Reads Tally and sends unpaid bills, party balances, receipts")
	fmt.Println("  and payments to ZT-ERP LITE every 5 minutes.")
	fmt.Println("  It ONLY READS from Tally. Nothing is ever changed in Tally.")
	fmt.Println("==============================================================")
	fmt.Println()
}

func setup(c *Config) {
	if c == nil {
		c = &Config{Tally: "http://localhost:9000"}
	}
	// 1. Tally
	fmt.Println("STEP 1 of 3: Checking Tally on this computer")
	for {
		cos, err := newTally(c.Tally).Companies()
		if err == nil && len(cos) == 0 {
			if _, e := newTally(c.Tally).Ledgers("", time.Now()); e == nil {
				cos = []string{"(the company open now)"}
			}
		}
		if err == nil && len(cos) > 0 {
			fmt.Printf("  [OK] Tally answered. Companies open: %s\n\n", strings.Join(cos, ", "))
			break
		}
		if err == nil {
			fmt.Println("  [!] Tally answered, but no company is open. Open your company in Tally.")
		} else {
			fmt.Printf("  [X] Tally did not answer at %s\n", c.Tally)
			fmt.Println("      1. Open Tally and your company on this computer.")
			fmt.Println("      2. TallyPrime: press F1 (Help) > Settings > Connectivity.")
			fmt.Println("         Set 'TallyPrime acts as' = Both, and Port = 9000. Save (Ctrl+A).")
			fmt.Println("         Tally.ERP 9: F12 > Advanced Configuration: acting as Both, Port 9000.")
			fmt.Println("      3. Close Tally and open it again.")
		}
		a := ask("  Press Enter to check again (or type another port number, or Q to stop): ")
		if strings.EqualFold(a, "q") {
			return
		}
		if a != "" && strings.Trim(a, "0123456789") == "" {
			c.Tally = "http://localhost:" + a
		}
	}
	// 2. Setup code
	fmt.Println("STEP 2 of 3: Setup code from ZT-ERP LITE")
	fmt.Println("  The Admin makes it in ZT-ERP LITE > Tally sync > Setup > Make sync key.")
	var secret string
	for {
		a := ask("  Paste the setup code here (right-click to paste), then press Enter:\n  > ")
		if strings.EqualFold(a, "q") {
			return
		}
		erp, s, err := parseCode(a)
		if err != nil {
			fmt.Printf("  [X] %v. Try again, or Q to stop.\n", err)
			continue
		}
		fmt.Printf("  Checking the code with %s ...\n", erp)
		j, err := erpPost(erp, s, "tally/ping", map[string]any{})
		if err != nil {
			fmt.Printf("  [X] %v\n", err)
			continue
		}
		fmt.Printf("  [OK] Code accepted (key \"%v\").\n\n", j["label"])
		c.ERP, secret = erp, s
		break
	}
	// 3. Install
	fmt.Println("STEP 3 of 3: Installing")
	enc, err := protect([]byte(secret))
	if err != nil {
		fmt.Printf("  [X] Could not save the key safely: %v\n", err)
		pause()
		return
	}
	c.Key = base64.StdEncoding.EncodeToString(enc)
	if err := saveCfg(c); err != nil {
		fmt.Printf("  [X] Could not save settings: %v\n", err)
		pause()
		return
	}
	exe, err := selfInstall()
	if err != nil {
		fmt.Printf("  [X] Could not copy the program: %v\n", err)
		pause()
		return
	}
	if err := makeTask(exe); err != nil {
		fmt.Printf("  [X] Could not set the 5-minute schedule: %v\n", err)
		pause()
		return
	}
	makeShortcut(exe)
	fmt.Println("  [OK] Installed. It runs every 5 minutes while this PC is on and this user is logged in.")
	fmt.Println("       To see its status later: Start menu > type 'ZT Tally Sync'.")
	fmt.Println()
	fmt.Println("First sync now:")
	syncNow(c)
	fmt.Println()
	fmt.Println("All done. Keep Tally open with the company loaded during the day.")
	pause()
}

func syncNow(c *Config) {
	unlock, ok := lock()
	if !ok {
		fmt.Println("  A sync is already running. Try again in a minute.")
		return
	}
	defer unlock()
	msg, err := syncOnce(c, func(f string, a ...any) { fmt.Printf("  "+f+"\n", a...) })
	if err != nil {
		fmt.Printf("  [X] %v\n", err)
		logf("ERROR %v", err)
		writeLast(false, err.Error())
		return
	}
	fmt.Printf("  [OK] %s\n", msg)
	logf("%s", msg)
	writeLast(true, msg)
}

func menu(c *Config) {
	for {
		fmt.Println("Status")
		fmt.Printf("  Sends to:  %s\n", c.ERP)
		fmt.Printf("  Tally at:  %s\n", c.Tally)
		if b, err := os.ReadFile(lastPath()); err == nil {
			var l Last
			json.Unmarshal(b, &l)
			st := "OK"
			if !l.OK {
				st = "PROBLEM"
			}
			fmt.Printf("  Last sync: %s  %s  %s\n", l.At, st, l.Message)
		} else {
			fmt.Println("  Last sync: not yet")
		}
		fmt.Println()
		fmt.Println("  1  Sync now")
		fmt.Println("  2  Enter a new setup code")
		fmt.Println("  3  Show the log")
		fmt.Println("  4  Remove Tally sync from this computer")
		fmt.Println("  5  Close")
		switch ask("Type a number and press Enter: ") {
		case "1":
			syncNow(c)
		case "2":
			setup(c)
			return
		case "3":
			b, _ := os.ReadFile(logPath())
			if len(b) > 4000 {
				b = b[len(b)-4000:]
			}
			fmt.Println(string(b))
		case "4":
			if strings.EqualFold(ask("Remove it? Tally data stops going to the ERP. Type YES: "), "yes") {
				uninstall()
				fmt.Println("  Removed. The ERP keeps the last data it got.")
				pause()
				return
			}
		case "5", "":
			return
		}
		fmt.Println()
	}
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--once":
			os.Exit(runOnce())
		case "--uninstall":
			uninstall()
			return
		}
	}
	openConsole("ZT Tally Sync")
	in = bufio.NewReader(os.Stdin)
	header()
	c, err := loadCfg()
	if err == nil && c.Key != "" {
		// a newer copy opened from Downloads: put it in place of the installed one, so the 5-minute task runs the new version
		if me, e := os.Executable(); e == nil {
			if a, _ := filepath.Abs(me); !strings.EqualFold(a, exeTarget()) {
				if _, e := selfInstall(); e != nil {
					fmt.Printf("  [!] Could not update the installed program (%v). Close this window and open it again in a minute.\n\n", e)
				} else {
					fmt.Printf("  [OK] Installed program updated to version %s.\n\n", version)
				}
			}
		}
		menu(c)
		return
	}
	setup(nil)
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func purSay(co Company) string {
	if !co.PurOK {
		return "purchases not read (" + co.PurErr + ")"
	}
	n := 0
	for _, p := range co.Pur {
		n += p.N
	}
	return fmt.Sprintf("%d purchase vouchers and debit notes", n)
}
