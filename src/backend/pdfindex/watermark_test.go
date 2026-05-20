package pdfindex

import "testing"

func TestIsWatermark(t *testing.T) {
	terms := []string{"www.chinafix.com", "vinafix"}
	cases := []struct {
		in   string
		want bool
	}{
		{"w w w . c h i n a f i x . c o m", true},
		{"WWW.ChinaFix.com", true},
		{"STM32F407", false},
		{"see vinafix forum", true},
	}
	for _, c := range cases {
		if got := IsWatermark(c.in, terms); got != c.want {
			t.Errorf("IsWatermark(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestCleanPageTextDropsWatermarkLines(t *testing.T) {
	terms := []string{"chinafix"}
	out := CleanPageText("USB-C CONNECTOR\nwww.chinafix.com\n100 101", terms)
	if got := out; got != "USB-C CONNECTOR" {
		t.Errorf("CleanPageText = %q, want %q", got, "USB-C CONNECTOR")
	}
}
