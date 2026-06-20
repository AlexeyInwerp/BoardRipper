# Function → net/IC dictionary

Maps a repair "function" to the net-name patterns and IC/package hints used by the
find-by-function playbook. **Hybrid model:** these seed entries are high-confidence
shortcuts; when a function isn't here, the helper falls back to dynamic PDF/OBD/net
search and says so.

How to use (in the playbook):
- **net patterns** → `list_nets(filter=…)` candidates (step 4). Patterns are case-insensitive substrings; `*` is just a readability marker, match on the core token (e.g. `CHGR`, `PPVIN`).
- **IC/package hint** → enriches the `pdf_search` query (step 2) and the candidate ranking (step 4).

Leaning Apple/ODM-laptop to match the corpus. **Maintainer: prune/extend freely**, especially for non-Apple ODMs (Compal/Quanta/Wistron naming differs).

| key | net-name patterns | IC / package hint | notes |
|-----|-------------------|-------------------|-------|
| charger | `CHGR`, `PPDCIN`, `ACDC`, `PPVBAT`, `PPBUS_G3H` | charge controller (QFN), near the DC-in / USB-C | the IC with many `CHGR*`/phase/sense pins |
| smc / ec | `SMC`, `PM_`, `_EC_`, `PMU_` | large QFP/QFN (system mgmt controller) | often the biggest non-SoC controller |
| pmic | clustered `PP*` output rails, `PMU`, `S0_`, `S5_` | large BGA power-management IC | many regulated `PP*` rails fan out from it |
| usb-pd | `USBC`+`_CC`, `VBUS`, `_PD_`, `CC1`/`CC2` | per-port USB-C PD controller | one per USB-C port; look at CC lines |
| backlight | `BKL`, `LCD_BL`, `PPVOUT_BL`, `WLED` | boost/LED driver | near the display connector |
| ram / dram | `DDR`, `VDDQ`, `_CA_`, `_DQ_`, `VTT` | DRAM/PMIC near SoC (BGA) | termination + VDDQ rails |
| ssd / nand | `NAND`, `PCIE`+`SSD`, `PPVNAND`, `NVME` | storage controller / NAND (BGA) | |
| audio | `SPKR`, `HP_`, `CODEC`, `_I2S_`, `MIC_` | codec + speaker amp | amp near the speaker connector |
| wifi / bt | `WIFI`, `WLAN`, `BT_`, `_RF_`, `WL_` | RF module / connector | |
| trackpad / kbd | `TRKPD`, `TP_`, `KBD`, `_HID_` | HID bridge / connector | |

Add rows as needed. Keep patterns specific enough that `list_nets(filter)` returns a
tractable set, not hundreds.
