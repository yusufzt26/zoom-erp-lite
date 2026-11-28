package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// A fake Tally answering the same kind of XML that TallyPrime sends back
func fakeTally(t *testing.T, reqs *[]string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		q := string(b)
		*reqs = append(*reqs, q)
		if strings.Contains(q, "<TALLYREQUEST>Import") {
			t.Fatalf("the program must never import into Tally")
		}
		switch {
		case strings.Contains(q, "ZTCompanies"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Zoom Technologies 2026-27" RESERVEDNAME=""><NAME TYPE="String">Zoom Technologies 2026-27</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "$$GroupSundryDebtors"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION>
			<LEDGER NAME="A One Industries" RESERVEDNAME=""><PARENT TYPE="String">Sundry Debtors</PARENT><CLOSINGBALANCE TYPE="Amount">-387040.00</CLOSINGBALANCE><PARTYGSTIN>27aabca1234b1z5</PARTYGSTIN><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>
			<LEDGER NAME="Cash Customer &amp; Co" RESERVEDNAME=""><PARENT TYPE="String">Pune Debtors</PARENT><CLOSINGBALANCE TYPE="Amount">-5000.00</CLOSINGBALANCE><ISBILLWISEON>No</ISBILLWISEON></LEDGER>
			</COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "$$GroupSundryCreditors"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><LEDGER NAME="Kirti Alloys" RESERVEDNAME=""><PARENT TYPE="String">Sundry Creditors</PARENT><CLOSINGBALANCE TYPE="Amount">47200.00</CLOSINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "Bills Receivable"):
			// UTF-16 with a stray control character, as some Tally versions send
			s := "\ufeff<ENVELOPE><BILLFIXED><BILLDATE>27-Jul-2026</BILLDATE><BILLREF>Z1607/26-27</BILLREF><BILLPARTY>A One Industries</BILLPARTY></BILLFIXED><BILLCL>-259600.00</BILLCL><BILLDUE>10-Sep-2026</BILLDUE><BILLOVERDUE>77</BILLOVERDUE>" +
				"<BILLFIXED><BILLDATE>3-Nov-2026</BILLDATE><BILLREF>Z1656/26-27&#4;</BILLREF><BILLPARTY>A One Industries</BILLPARTY></BILLFIXED><BILLCL>-127440.00</BILLCL><BILLDUE>18-Dec-2026</BILLDUE><BILLOVERDUE>0</BILLOVERDUE></ENVELOPE>"
			u := utf16.Encode([]rune(s))
			out := make([]byte, 0, len(u)*2)
			for _, c := range u {
				out = append(out, byte(c), byte(c>>8))
			}
			w.Write(out)
		case strings.Contains(q, "Bills Payable"):
			io.WriteString(w, `<ENVELOPE><BILLFIXED><BILLDATE>1-Nov-2026</BILLDATE><BILLREF>INV-880</BILLREF><BILLPARTY>Kirti Alloys</BILLPARTY></BILLFIXED><BILLCL>47200.00</BILLCL><BILLDUE>1-Dec-2026</BILLDUE><BILLOVERDUE>0</BILLOVERDUE></ENVELOPE>`)
		case strings.Contains(q, "$$IsReceipt"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER REMOTEID="x" VCHTYPE="Receipt"><DATE TYPE="Date">20261120</DATE><GUID>g-1</GUID><VOUCHERNUMBER>410</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>A One Industries</PARTYLEDGERNAME><AMOUNT>50000.00</AMOUNT><NARRATION>NEFT</NARRATION></VOUCHER>
			<VOUCHER><DATE>20250101</DATE><GUID>too-old</GUID><AMOUNT>1</AMOUNT></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "$$IsPayment"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><DATE>20261118</DATE><GUID>g-2</GUID><VOUCHERNUMBER>220</VOUCHERNUMBER><VOUCHERTYPENAME>Bank Payment</VOUCHERTYPENAME><PARTYLEDGERNAME>Kirti Alloys</PARTYLEDGERNAME><AMOUNT>-30000.00</AMOUNT></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "ZTTaxLed"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><LEDGER NAME="Input CGST 9%"><TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Central Tax</GSTDUTYHEAD></LEDGER><LEDGER NAME="Input SGST 9%"><TAXTYPE>GST</TAXTYPE></LEDGER><LEDGER NAME="IGST Input"></LEDGER><LEDGER NAME="TDS on Contract"><TAXTYPE>TDS</TAXTYPE></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "$$IsPurchase"):
			// item invoice with CGST+SGST, an accounting voucher with IGST, and one from last year (too old)
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION>
			<VOUCHER VCHTYPE="Purchase"><DATE>20261105</DATE><GUID>p-1</GUID><PARTYLEDGERNAME>Kirti Alloys</PARTYLEDGERNAME><AMOUNT>-118000.00</AMOUNT>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Kirti Alloys</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>118000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase GST 18%</LEDGERNAME><AMOUNT>-100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST 9%</LEDGERNAME><AMOUNT>-9000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST 9%</LEDGERNAME><AMOUNT>-9000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
			<VOUCHER><DATE>20261020</DATE><GUID>p-2</GUID><PARTYLEDGERNAME>Ravi Steels</PARTYLEDGERNAME>
			<LEDGERENTRIES.LIST><LEDGERNAME>Ravi Steels</LEDGERNAME><AMOUNT>59000.00</AMOUNT></LEDGERENTRIES.LIST>
			<LEDGERENTRIES.LIST><LEDGERNAME>Purchase Interstate</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></LEDGERENTRIES.LIST>
			<LEDGERENTRIES.LIST><LEDGERNAME>IGST Input</LEDGERNAME><AMOUNT>-9000.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>
			<VOUCHER><DATE>20240101</DATE><GUID>p-old</GUID><AMOUNT>-5</AMOUNT></VOUCHER>
			</COLLECTION></DATA></BODY></ENVELOPE>`)
		case strings.Contains(q, "$$IsDebitNote"):
			io.WriteString(w, `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><DATE>20261110</DATE><GUID>d-1</GUID><PARTYLEDGERNAME>Kirti Alloys</PARTYLEDGERNAME>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Kirti Alloys</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase GST 18%</LEDGERNAME><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST 9%</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
			<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST 9%</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`)
		default:
			io.WriteString(w, `<RESPONSE><LINEERROR>Unknown request</LINEERROR></RESPONSE>`)
		}
	}))
}

func TestSync(t *testing.T) {
	os.Setenv("ZT_INSTALL_DIR", t.TempDir())
	var reqs []string
	tally := fakeTally(t, &reqs)
	defer tally.Close()
	var got Payload
	var key string
	erp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key = r.Header.Get("x-sync-key")
		json.NewDecoder(r.Body).Decode(&got)
		io.WriteString(w, `{"ok":true,"changed":7}`)
	}))
	defer erp.Close()
	enc, _ := protect([]byte("secret-123456789012345"))
	c := &Config{ERP: erp.URL, Tally: tally.URL, Key: b64(enc), Companies: []string{"Old Company 2025-26"}}
	msg, err := syncOnce(c, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(msg)
	if key != "secret-123456789012345" {
		t.Fatalf("key %q", key)
	}
	if len(got.Companies) != 2 {
		t.Fatalf("companies %d", len(got.Companies))
	}
	co := got.Companies[0]
	if !co.OK || co.Name != "Zoom Technologies 2026-27" {
		t.Fatalf("company %+v", co)
	}
	if got.Companies[1].OK || got.Companies[1].Error != "Company not open in Tally" {
		t.Fatalf("closed company must be reported: %+v", got.Companies[1])
	}
	if len(co.Bills) != 3 || co.Bills[0].L != "A One Industries" || co.Bills[0].Due != 259600 || co.Bills[0].D != "2026-07-27" || co.Bills[0].DueOn != "2026-09-10" {
		t.Fatalf("bills %+v", co.Bills)
	}
	if co.Bills[1].Ref != "Z1656/26-27" {
		t.Fatalf("control character not removed: %q", co.Bills[1].Ref)
	}
	if co.Bills[2].K != "sup" || co.Bills[2].Due != 47200 {
		t.Fatalf("supplier bill %+v", co.Bills[2])
	}
	if len(co.Ledgers) != 3 || co.Ledgers[0].Due != 387040 || co.Ledgers[0].Gst != "27AABCA1234B1Z5" || co.Ledgers[1].N != "Cash Customer & Co" || co.Ledgers[1].Due != 5000 || co.Ledgers[2].Due != 47200 {
		t.Fatalf("ledgers %+v", co.Ledgers)
	}
	if len(co.Vch) != 2 || co.Vch[0].T != "rcpt" || co.Vch[0].Amt != 50000 || co.Vch[1].T != "pay" || co.Vch[1].Amt != 30000 || co.Vch[1].Vt != "Bank Payment" {
		t.Fatalf("vouchers %+v", co.Vch)
	}
	want := []PurMonth{{M: "2026-11", T: "dn", Amt: 11800, Net: 10000, N: 1}, {M: "2026-10", T: "pur", Amt: 59000, Net: 50000, N: 1}, {M: "2026-11", T: "pur", Amt: 118000, Net: 100000, N: 1}}
	if !co.PurOK || len(co.Pur) != 3 || co.Pur[0] != want[0] || co.Pur[1] != want[1] || co.Pur[2] != want[2] {
		t.Fatalf("purchases %+v", co.Pur)
	}
	if got.PurFrom == "" || got.PurFrom > "2026-04-01" {
		t.Fatalf("purFrom %q", got.PurFrom)
	}
	for _, q := range reqs {
		if !strings.Contains(q, "Export") {
			t.Fatalf("not an export request: %s", q)
		}
	}
	if len(c.Companies) != 2 {
		t.Fatalf("seen companies not saved: %v", c.Companies)
	}
}

func TestTallyClosed(t *testing.T) {
	os.Setenv("ZT_INSTALL_DIR", t.TempDir())
	var got Payload
	erp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		io.WriteString(w, `{"ok":true,"changed":0}`)
	}))
	defer erp.Close()
	enc, _ := protect([]byte("k"))
	c := &Config{ERP: erp.URL, Tally: "http://127.0.0.1:1", Key: b64(enc), Companies: []string{"Zoom"}}
	_, err := syncOnce(c, t.Logf)
	if err == nil || !strings.Contains(got.Error, "not open") || len(got.Companies) != 1 || got.Companies[0].OK {
		t.Fatalf("Tally closed must still tell the ERP: %v %+v", err, got)
	}
}

func TestSignFix(t *testing.T) {
	L := []Ledger{{N: "A", K: "cust", Due: -1000}, {N: "B", K: "cust", Due: -500}}
	B := []Bill{{K: "cust", L: "A", Due: 1000}, {K: "cust", L: "B", Due: 500}}
	if !fixLedgerSign(L, B) || L[0].Due != 1000 {
		t.Fatalf("sign not fixed %+v", L)
	}
	if fixLedgerSign(L, B) {
		t.Fatal("must not flip back")
	}
}

func TestPurFrom(t *testing.T) {
	for in, want := range map[string]string{"2026-11-28": "2025-04-01", "2027-03-31": "2025-04-01", "2027-04-01": "2026-04-01"} {
		d, _ := time.Parse("2006-01-02", in)
		if s := purFrom(d).Format("2006-01-02"); s != want {
			t.Errorf("purFrom(%s)=%s", in, s)
		}
	}
}

func TestBits(t *testing.T) {
	for in, want := range map[string]float64{"-1234.50": -1234.5, "1,234.50 Dr": -1234.5, "1,234.50 Cr": 1234.5, "(-)99": -99, "": 0} {
		if amount(in) != want {
			t.Errorf("amount(%q)=%v", in, amount(in))
		}
	}
	for in, want := range map[string]string{"20261101": "2026-11-01", "1-Nov-2026": "2026-11-01", "01-Nov-26": "2026-11-01", "x": ""} {
		if isoDate(in) != want {
			t.Errorf("isoDate(%q)=%v", in, isoDate(in))
		}
	}
	e, s, err := parseCode(" ZTS1.aHR0cHM6Ly96b29tLWVycC1saXRlLm5ldGxpZnkuYXBw.abcdefghijklmnopqrstuvwxyz012345 ")
	if err != nil || e != "https://zoom-erp-lite.netlify.app" || s != "abcdefghijklmnopqrstuvwxyz012345" {
		t.Fatalf("parseCode %v %v %v", e, s, err)
	}
	if _, _, err := parseCode("hello"); err == nil {
		t.Fatal("bad code accepted")
	}
}

// ZT_E2E_ERP=http://localhost:8899 ZT_E2E_KEY=... go test -run E2E : fake Tally -> real ERP API
func TestE2E(t *testing.T) {
	if os.Getenv("ZT_E2E_ERP") == "" {
		t.Skip("set ZT_E2E_ERP")
	}
	os.Setenv("ZT_INSTALL_DIR", t.TempDir())
	var reqs []string
	tally := fakeTally(t, &reqs)
	defer tally.Close()
	erp, secret, err := parseCode(os.Getenv("ZT_E2E_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := erpPost(erp, secret, "tally/ping", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	enc, _ := protect([]byte(secret))
	msg, err := syncOnce(&Config{ERP: erp, Tally: tally.URL, Key: b64(enc)}, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(msg)
}
