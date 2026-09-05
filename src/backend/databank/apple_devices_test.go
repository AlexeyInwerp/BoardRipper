package databank

import "testing"

func TestAppleDeviceModel(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"XZZ/Phones/iPhone/iPhone16_16Plus/Schematic and boardview/iPhone16_16Plus AP+BB Boardview.pcb", "iPhone 16 / 16 Plus"},
		{"iPhone14Pro_ProMAX/iPhone14 Pro_ProMAX Boardview 820-02588-10 820-02672-12.pcb", "iPhone 14 Pro / Pro Max"},
		{"iPhoneXSMAX/iPhoneXSMAX boardview(Diode value).pcb", "iPhone XS Max"},
		{"iPhoneXR/Schematic and boardview/XR.pcb", "iPhone XR"},
		{"iPhone12_12Pro/iPhone12&12Pro PCB layer.pcb", "iPhone 12 / 12 Pro"},
		{"iPhone13ProMAX/iPhone13ProMax_AP 820-02400-06 PCB layer.pcb", "iPhone 13 Pro Max"},
		{"iPhone11Pro_ProMax/iPhone11Pro&ProMAX-PCB layer.pcb", "iPhone 11 Pro / Pro Max"},
		{"iPhone12mini/iPhone12mini YiDianTong.pcb", "iPhone 12 mini"},
		{"iPhoneSE2 PCB layer 820-01869.pcb", "iPhone SE 2"},
		{"iPhoneSE/iPhoneSE boardview.pcb", "iPhone SE"},
		{"iPhone16E/iPhone16E MB+SUB YiDianTong.pcb", "iPhone 16E"},
		{"iPhone17Air/iPhone17Air 820-03415-06 Boardview.pcb", "iPhone 17 Air"},
		{"iPhone 11-A surface.pcb", "iPhone 11"},
		{"iPhone13/iPhone 13_AP-820-02402-05 PCB layer.pcb", "iPhone 13"},
		{"iPhone7 intel PCB layer 820-00189-A.pcb", "iPhone 7"},
		{"iPhone15Pro_ProMax AP+BB Boardview.pcb", "iPhone 15 Pro / Pro Max"},
		{"iPhone15_15 Plus AP+BB Boardview.pcb", "iPhone 15 / 15 Plus"},
		{"iPhone16Pro_ProMax-820-03424-14 AP+BB YiDianTong.pcb", "iPhone 16 Pro / Pro Max"},
		{"iPhoneSE3 YiDianTong 820-02524.pcb", "iPhone SE 3"},
		{"iPad/iPad Pro 12.9 3rd gen 820-01204.pcb", "iPad Pro 12.9"},
		{"MacBook Pro M1 Pro 14' A2442 820-02098-A PCB layer.pcb", ""},
		{"ASUS/FA507RM.pcb", ""},
	}
	for _, c := range cases {
		got, ok := appleDeviceModel(c.path)
		if c.want == "" {
			if ok {
				t.Errorf("%q: expected no match, got %q", c.path, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("%q: got %q (ok=%v), want %q", c.path, got, ok, c.want)
		}
	}
}

func TestExtractMetadataAppleDevice(t *testing.T) {
	m := ExtractMetadataWithBoardDB("XZZ PCB SAMPLES/nas-iphone/XZZ/Phones/iPhone/iPhone16_16Plus/Schematic and boardview/iPhone16_16Plus AP+BB Boardview.pcb", nil)
	if m.Manufacturer != "Apple" || m.Model != "iPhone 16 / 16 Plus" || m.ResolutionStatus != "resolved" {
		t.Errorf("unexpected metadata: %+v", m)
	}
}

func TestApplePlaceholderModelReplaced(t *testing.T) {
	// The placeholder-model override only fires on a boards.db hit; without a
	// DB the path model must still come through the keyword fallback.
	m := ExtractMetadataWithBoardDB("iPhone16Pro_ProMax/iPhone16Pro_ProMax-820-03424-14 AP+BB Boardview.pcb", nil)
	if m.Model != "iPhone 16 Pro / Pro Max" || m.BoardNumber != "820-03424" {
		t.Errorf("unexpected metadata: %+v", m)
	}
}
