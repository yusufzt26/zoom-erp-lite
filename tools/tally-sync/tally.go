package main

// Reading Tally (TallyPrime or Tally.ERP 9) through its XML port. Every request here is an Export:
// nothing is ever imported or changed in Tally.

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type node struct {
	Name string
	Attr map[string]string
	Text string
	Kids []*node
}

func (n *node) child(name string) *node {
	for _, k := range n.Kids {
		if k.Name == name {
			return k
		}
	}
	return nil
}
func (n *node) val(name string) string {
	if c := n.child(name); c != nil {
		return strings.TrimSpace(c.Text)
	}
	return ""
}
func (n *node) walk(f func(*node)) {
	f(n)
	for _, k := range n.Kids {
		k.walk(f)
	}
}

var badRef = regexp.MustCompile(`&#(x[0-9A-Fa-f]+|[0-9]+);`)
var xmlDecl = regexp.MustCompile(`^\s*<\?xml[^>]*\?>`)

// Tally's answers can be UTF-16 and can hold control characters that are not valid XML; clean them first.
func cleanXML(b []byte) []byte {
	if len(b) >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF) || (len(b) > 4 && b[1] == 0 && b[3] == 0)) {
		be := b[0] == 0xFE
		if (b[0] == 0xFF && b[1] == 0xFE) || be {
			b = b[2:]
		}
		u := make([]uint16, len(b)/2)
		for i := range u {
			if be {
				u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
			} else {
				u[i] = uint16(b[2*i+1])<<8 | uint16(b[2*i])
			}
		}
		b = []byte(string(utf16.Decode(u)))
	}
	b = bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF"))
	b = xmlDecl.ReplaceAll(b, nil)
	b = badRef.ReplaceAllFunc(b, func(m []byte) []byte {
		s := string(m[2 : len(m)-1])
		var v int64
		if strings.HasPrefix(s, "x") {
			v, _ = strconv.ParseInt(s[1:], 16, 32)
		} else {
			v, _ = strconv.ParseInt(s, 10, 32)
		}
		if v < 32 && v != 9 && v != 10 && v != 13 {
			return nil
		}
		return m
	})
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c < 32 && c != 9 && c != 10 && c != 13 {
			continue
		}
		out = append(out, c)
	}
	return out
}

func parseXML(b []byte) (*node, error) {
	d := xml.NewDecoder(bytes.NewReader(cleanXML(b)))
	d.Strict = false
	d.AutoClose = xml.HTMLAutoClose
	d.Entity = xml.HTMLEntity
	d.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	root := &node{Name: "#root"}
	stack := []*node{root}
	for {
		t, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return root, err
		}
		switch x := t.(type) {
		case xml.StartElement:
			n := &node{Name: strings.ToUpper(x.Name.Local), Attr: map[string]string{}}
			for _, a := range x.Attr {
				n.Attr[strings.ToUpper(a.Name.Local)] = a.Value
			}
			p := stack[len(stack)-1]
			p.Kids = append(p.Kids, n)
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			stack[len(stack)-1].Text += string(x)
		}
	}
	return root, nil
}

type tallyClient struct {
	URL string
	hc  *http.Client
}

func newTally(url string) *tallyClient {
	return &tallyClient{URL: strings.TrimRight(url, "/"), hc: &http.Client{Timeout: 180 * time.Second}}
}

var errNoTally = errors.New("Tally did not answer")

func (t *tallyClient) post(body string) (*node, error) {
	req, _ := http.NewRequest("POST", t.URL, strings.NewReader(body))
	req.Header.Set("Content-Type", "text/xml; charset=utf-8")
	res, err := t.hc.Do(req)
	if err != nil {
		return nil, errNoTally
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 200<<20))
	if err != nil {
		return nil, fmt.Errorf("could not read Tally's answer: %v", err)
	}
	root, perr := parseXML(b)
	var lineErr string
	root.walk(func(n *node) {
		if lineErr == "" && n.Name == "LINEERROR" {
			lineErr = strings.TrimSpace(n.Text)
		}
	})
	if lineErr != "" {
		return root, fmt.Errorf("Tally says: %s", lineErr)
	}
	if perr != nil && len(root.Kids) == 0 {
		return root, fmt.Errorf("Tally's answer could not be read: %v", perr)
	}
	return root, nil
}

func esc(s string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

func tdate(t time.Time) string { return t.Format("2-Jan-2006") }

func statics(company string, from, to time.Time) string {
	s := "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
	if company != "" {
		s += "<SVCURRENTCOMPANY>" + esc(company) + "</SVCURRENTCOMPANY>"
	}
	if !from.IsZero() {
		s += "<SVFROMDATE>" + tdate(from) + "</SVFROMDATE>"
	}
	if !to.IsZero() {
		s += "<SVTODATE>" + tdate(to) + "</SVTODATE>"
	}
	return "<STATICVARIABLES>" + s + "</STATICVARIABLES>"
}

func collectionReq(id, company string, from, to time.Time, tdl string) string {
	return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>` + id + `</ID></HEADER><BODY><DESC>` +
		statics(company, from, to) + `<TDL><TDLMESSAGE>` + tdl + `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`
}

func reportReq(report, company string, to time.Time) string {
	return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>` + esc(report) +
		`</REPORTNAME>` + statics(company, time.Time{}, to) + `</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`
}

// Companies open in Tally right now
func (t *tallyClient) Companies() ([]string, error) {
	r, err := t.post(collectionReq("ZTCompanies", "", time.Time{}, time.Time{},
		`<COLLECTION NAME="ZTCompanies" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>Name</FETCH></COLLECTION>`))
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	r.walk(func(n *node) {
		if n.Name != "COMPANY" {
			return
		}
		name := strings.TrimSpace(n.Attr["NAME"])
		if name == "" {
			name = n.val("NAME")
		}
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	})
	return out, nil
}

type Ledger struct {
	N   string  `json:"n"`
	K   string  `json:"k"`
	G   string  `json:"g"`
	Gst string  `json:"gst,omitempty"`
	Due float64 `json:"due"`
	Bw  bool    `json:"bw"`
}
type Bill struct {
	K     string  `json:"k"`
	L     string  `json:"l"`
	Ref   string  `json:"ref"`
	D     string  `json:"d"`
	DueOn string  `json:"dueOn,omitempty"`
	Due   float64 `json:"due"`
}
type Vch struct {
	G   string  `json:"g"`
	T   string  `json:"t"`
	Vt  string  `json:"vt,omitempty"`
	D   string  `json:"d"`
	No  string  `json:"no"`
	L   string  `json:"l"`
	Amt float64 `json:"amt"`
	Nar string  `json:"nar,omitempty"`
}

var amtRe = regexp.MustCompile(`-?[0-9][0-9,]*(\.[0-9]+)?`)

// Tally amounts: "-1234.50", "1,234.50 Dr", "(-)1234.50"; debit is negative, as in Tally's XML
func amount(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	neg := strings.Contains(s, "(-)") || strings.HasPrefix(s, "-")
	m := amtRe.FindString(strings.ReplaceAll(s, "(-)", ""))
	v, _ := strconv.ParseFloat(strings.ReplaceAll(strings.TrimPrefix(m, "-"), ",", ""), 64)
	l := strings.ToLower(s)
	if strings.HasSuffix(l, "dr") {
		neg = true
	} else if strings.HasSuffix(l, "cr") {
		neg = false
	}
	if neg {
		v = -v
	}
	return math.Round(v*100) / 100
}

var months = map[string]time.Month{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
var dRe = regexp.MustCompile(`^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$`)

// "20261101", "1-Nov-2026", "1-Nov-26" -> "2026-11-01"
func isoDate(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 8 {
		if _, err := strconv.Atoi(s); err == nil {
			return s[0:4] + "-" + s[4:6] + "-" + s[6:8]
		}
	}
	if m := dRe.FindStringSubmatch(s); m != nil {
		mo, ok := months[strings.ToLower(m[2])]
		if !ok {
			return ""
		}
		d, _ := strconv.Atoi(m[1])
		y, _ := strconv.Atoi(m[3])
		if y < 100 {
			y += 2000
		}
		return fmt.Sprintf("%04d-%02d-%02d", y, int(mo), d)
	}
	if len(s) >= 10 && s[4] == '-' && s[7] == '-' {
		return s[:10]
	}
	return ""
}

func yes(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	return s == "yes" || s == "true" || s == "1"
}

// Party ledgers: everything under Sundry Debtors (customers) and Sundry Creditors (suppliers), sub-groups included
func (t *tallyClient) Ledgers(company string, to time.Time) ([]Ledger, error) {
	var out []Ledger
	for _, g := range []struct{ k, grp string }{{"cust", "$$GroupSundryDebtors"}, {"sup", "$$GroupSundryCreditors"}} {
		r, err := t.post(collectionReq("ZTParties", company, time.Time{}, to,
			`<COLLECTION NAME="ZTParties" ISMODIFY="No"><TYPE>Ledger</TYPE><CHILDOF>`+g.grp+`</CHILDOF><BELONGSTO>Yes</BELONGSTO><FETCH>Name,Parent,ClosingBalance,PartyGSTIN,IsBillWiseOn</FETCH></COLLECTION>`))
		if err != nil {
			return nil, err
		}
		r.walk(func(n *node) {
			if n.Name != "LEDGER" {
				return
			}
			name := strings.TrimSpace(n.Attr["NAME"])
			if name == "" {
				name = n.val("NAME")
			}
			if name == "" {
				return
			}
			cl := amount(n.val("CLOSINGBALANCE"))
			due := cl // supplier: credit (positive) is what we owe
			if g.k == "cust" {
				due = -cl // customer: debit (negative in Tally XML) is what they owe us
			}
			out = append(out, Ledger{N: name, K: g.k, G: n.val("PARENT"), Gst: strings.ToUpper(n.val("PARTYGSTIN")), Due: due, Bw: yes(n.val("ISBILLWISEON"))})
		})
	}
	return out, nil
}

// Unpaid bills from Tally's own Bills Receivable and Bills Payable reports, as on today
func (t *tallyClient) Bills(company string, to time.Time, kindOf map[string]string) ([]Bill, error) {
	var out []Bill
	for _, rp := range []struct{ name, kind string }{{"Bills Receivable", "cust"}, {"Bills Payable", "sup"}} {
		r, err := t.post(reportReq(rp.name, company, to))
		if err != nil {
			return nil, err
		}
		var cur *Bill
		var flush = func() {
			if cur != nil && cur.L != "" {
				out = append(out, *cur)
			}
			cur = nil
		}
		var env *node
		r.walk(func(n *node) {
			if env == nil && n.child("BILLFIXED") != nil {
				env = n
			}
		})
		if env == nil {
			continue
		}
		for _, n := range env.Kids {
			switch n.Name {
			case "BILLFIXED":
				flush()
				party := n.val("BILLPARTY")
				k := kindOf[party]
				if k == "" {
					k = rp.kind
				}
				cur = &Bill{K: k, L: party, Ref: n.val("BILLREF"), D: isoDate(n.val("BILLDATE"))}
			case "BILLCL":
				if cur != nil {
					v := math.Abs(amount(n.Text))
					dr := v // receivable report: debit pending
					if rp.kind == "sup" {
						dr = -v // payable report: credit pending
					}
					if cur.K == "cust" {
						cur.Due = dr
					} else {
						cur.Due = -dr
					}
				}
			case "BILLDUE":
				if cur != nil {
					cur.DueOn = isoDate(n.Text)
				}
			}
		}
		flush()
	}
	return out, nil
}

// Receipts and payments between two dates
func (t *tallyClient) Vouchers(company string, from, to time.Time) ([]Vch, error) {
	var out []Vch
	for _, v := range []struct{ t, fn string }{{"rcpt", "$$IsReceipt"}, {"pay", "$$IsPayment"}} {
		r, err := t.post(collectionReq("ZTVch", company, from, to,
			`<COLLECTION NAME="ZTVch" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>GUID,Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH><FILTER>ZTVchF</FILTER></COLLECTION>`+
				`<SYSTEM TYPE="Formulae" NAME="ZTVchF">`+v.fn+`:$VoucherTypeName AND NOT $IsCancelled AND NOT $IsOptional</SYSTEM>`))
		if err != nil {
			return nil, err
		}
		fromS, toS := from.Format("2006-01-02"), to.Format("2006-01-02")
		r.walk(func(n *node) {
			if n.Name != "VOUCHER" {
				return
			}
			d := isoDate(n.val("DATE"))
			if d != "" && (d < fromS || d > toS) {
				return
			}
			vt := n.val("VOUCHERTYPENAME")
			if vt == "" {
				vt = n.Attr["VCHTYPE"]
			}
			out = append(out, Vch{G: n.val("GUID"), T: v.t, Vt: vt, D: d, No: n.val("VOUCHERNUMBER"), L: n.val("PARTYLEDGERNAME"), Amt: math.Abs(amount(n.val("AMOUNT"))), Nar: n.val("NARRATION")})
		})
	}
	return out, nil
}

// GST ledgers (under Duties & Taxes), so a purchase voucher's amount can be split into before-GST and GST
var gstName = regexp.MustCompile(`(?i)\b(c|s|i|ut)?gst\b|cgst|sgst|igst|utgst|\bcess\b`)

func (t *tallyClient) gstLedgers(company string) (map[string]bool, error) {
	r, err := t.post(collectionReq("ZTTaxLed", company, time.Time{}, time.Time{},
		`<COLLECTION NAME="ZTTaxLed" ISMODIFY="No"><TYPE>Ledger</TYPE><CHILDOF>$$GroupDutiesTaxes</CHILDOF><BELONGSTO>Yes</BELONGSTO><FETCH>Name,TaxType,GSTDutyHead</FETCH></COLLECTION>`))
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	r.walk(func(n *node) {
		if n.Name != "LEDGER" {
			return
		}
		name := strings.TrimSpace(n.Attr["NAME"])
		if name == "" {
			name = n.val("NAME")
		}
		tt := strings.ToUpper(n.val("TAXTYPE"))
		if name != "" && (tt == "GST" || n.val("GSTDUTYHEAD") != "" || (tt == "" && gstName.MatchString(name))) {
			out[name] = true
		}
	})
	return out, nil
}

// Purchases (or debit notes) of one month, as Tally has them: Amt with GST, Net before GST, N vouchers
type PurMonth struct {
	M   string  `json:"m"`
	T   string  `json:"t"`
	Amt float64 `json:"amt"`
	Net float64 `json:"net"`
	N   int     `json:"n"`
}

// Purchase vouchers ("pur") and debit notes ("dn") between two dates, added up by month.
// With GST = the party's amount on the voucher; GST = the GST ledger lines; before GST = the difference.
func (t *tallyClient) Purchases(company string, from, to time.Time) ([]PurMonth, error) {
	gst, err := t.gstLedgers(company)
	if err != nil {
		return nil, err
	}
	fromS, toS := from.Format("2006-01-02"), to.Format("2006-01-02")
	tot := map[string]*PurMonth{}
	for _, v := range []struct{ t, fn string }{{"pur", "$$IsPurchase"}, {"dn", "$$IsDebitNote"}} {
		r, err := t.post(collectionReq("ZTPur", company, from, to,
			`<COLLECTION NAME="ZTPur" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>GUID,Date,VoucherTypeName,PartyLedgerName,Amount,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsPartyLedger</FETCH><FILTER>ZTPurF</FILTER></COLLECTION>`+
				`<SYSTEM TYPE="Formulae" NAME="ZTPurF">`+v.fn+`:$VoucherTypeName AND NOT $IsCancelled AND NOT $IsOptional</SYSTEM>`))
		if err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		r.walk(func(n *node) {
			if n.Name != "VOUCHER" {
				return
			}
			d := isoDate(n.val("DATE"))
			if d == "" || d < fromS || d > toS {
				return
			}
			if g := n.val("GUID"); g != "" {
				if seen[g] {
					return
				}
				seen[g] = true
			}
			party := n.val("PARTYLEDGERNAME")
			var lines []*node
			for _, k := range n.Kids {
				if k.Name == "ALLLEDGERENTRIES.LIST" {
					lines = append(lines, k)
				}
			}
			if len(lines) == 0 {
				for _, k := range n.Kids {
					if k.Name == "LEDGERENTRIES.LIST" {
						lines = append(lines, k)
					}
				}
			}
			var gross, tax, other float64
			hasParty := false
			for _, l := range lines {
				name, a := l.val("LEDGERNAME"), amount(l.val("AMOUNT"))
				switch {
				case yes(l.val("ISPARTYLEDGER")) || (party != "" && name == party):
					if !hasParty {
						gross, hasParty = math.Abs(a), true
					}
				case gst[name]:
					tax += a
				default:
					other += a
				}
			}
			if !hasParty {
				gross = math.Abs(amount(n.val("AMOUNT")))
				if gross == 0 {
					gross = math.Abs(tax + other)
				}
			}
			tax = math.Abs(tax)
			if tax > gross {
				tax = 0
			}
			k := v.t + d[:7]
			o := tot[k]
			if o == nil {
				o = &PurMonth{M: d[:7], T: v.t}
				tot[k] = o
			}
			o.Amt += gross
			o.Net += gross - tax
			o.N++
		})
	}
	out := []PurMonth{}
	for _, o := range tot {
		o.Amt, o.Net = math.Round(o.Amt*100)/100, math.Round(o.Net*100)/100
		out = append(out, *o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T+out[i].M < out[j].T+out[j].M })
	return out, nil
}

// First day purchases are read from: 1 April of last financial year, so this year and last year can both be shown
func purFrom(now time.Time) time.Time {
	y := now.Year() - 1
	if now.Month() < 4 {
		y--
	}
	return time.Date(y, 4, 1, 0, 0, 0, 0, now.Location())
}

// If ledger balances come out with the opposite sign to the bills (a Tally setting or version difference), turn them round.
func fixLedgerSign(L []Ledger, B []Bill) bool {
	by := map[string]float64{}
	for _, b := range B {
		by[b.K+"\x01"+b.L] += b.Due
	}
	flipped := false
	for _, k := range []string{"cust", "sup"} {
		var same, opp float64
		n := 0
		for _, l := range L {
			if l.K != k {
				continue
			}
			bs, ok := by[k+"\x01"+l.N]
			if !ok {
				continue
			}
			n++
			same += math.Abs(l.Due - bs)
			opp += math.Abs(-l.Due - bs)
		}
		if n > 0 && opp < same*0.5 {
			for i := range L {
				if L[i].K == k {
					L[i].Due = -L[i].Due
				}
			}
			flipped = true
		}
	}
	return flipped
}

type Company struct {
	Name    string     `json:"name"`
	OK      bool       `json:"ok"`
	Error   string     `json:"error,omitempty"`
	Flip    bool       `json:"flip,omitempty"`
	Ledgers []Ledger   `json:"ledgers"`
	Bills   []Bill     `json:"bills"`
	Vch     []Vch      `json:"vch"`
	Pur     []PurMonth `json:"pur"`
	PurOK   bool       `json:"purOk"`
	PurErr  string     `json:"purErr,omitempty"`
}

// Read one company: ledgers, bills, receipts and payments. Any part failing marks the company not read, so the ERP keeps its last data.
func (t *tallyClient) ReadCompany(name string, now time.Time, days int) Company {
	c := Company{Name: name}
	L, err := t.Ledgers(name, now)
	if err != nil {
		c.Error = err.Error()
		return c
	}
	kindOf := map[string]string{}
	for _, l := range L {
		kindOf[l.N] = l.K
	}
	B, err := t.Bills(name, now, kindOf)
	if err != nil {
		c.Error = err.Error()
		return c
	}
	from := now.AddDate(0, 0, -days)
	V, err := t.Vouchers(name, from, now)
	if err != nil {
		c.Error = err.Error()
		return c
	}
	// purchases are extra: if Tally cannot give them, the rest still goes and the ERP keeps the purchase figures it had
	if P, err := t.Purchases(name, purFrom(now), now); err != nil {
		c.PurErr = err.Error()
	} else {
		c.Pur, c.PurOK = P, true
	}
	c.Flip = fixLedgerSign(L, B)
	sort.Slice(B, func(i, j int) bool { return B[i].L < B[j].L })
	c.OK, c.Ledgers, c.Bills, c.Vch = true, L, B, V
	if c.Ledgers == nil {
		c.Ledgers = []Ledger{}
	}
	if c.Bills == nil {
		c.Bills = []Bill{}
	}
	if c.Vch == nil {
		c.Vch = []Vch{}
	}
	return c
}
