"""Indian Railways coach codes -> the class a coach is inspected and asked feedback under.

One rule set for coaches read from RailRadar (providers/railradar.py) and coaches typed in; the app keeps the
same rules in src/utils/coaches.js (inferClass). Per Railway Board Commercial Circular 07 of 2021 and the codes
seen in coach positions:

- AC: H (1A), HA (1A+2A), HB (1A+3A), A (2A), AB (2A+3A), B (3A), M (3E), G (Garib Rath 3A), C (CC),
  E (EC), J (Garib Rath chair car), K / EA (Anubhuti), EV (AC Vistadome).
- NON_AC: S (SL), D (2S), SS (second sitting), F / FC (first class), DV / VS (non-AC Vistadome).
- GEN (general, unreserved, non-AC): GEN, GS, GN, UR, UNR, and the guard/luggage coaches that carry general
  seating or the Divyangjan and ladies compartments: SLR, SLRD, SR, SRD, LRD, PWD, LDS.
- OTHER (not inspected, dropped from a rake): engine, power car, generator, pantry, luggage and parcel vans,
  train manager.

A numbered code that is none of these (DL1, say) is kept as NON_AC rather than dropped: a passenger coach is
rarely unnumbered, and its class can be corrected on the train. An unnumbered unknown code is dropped.
"""
import re

OTHER = re.compile(r"^(ENG|LOCO|PC|EOG|PWR|LPR|LUG|LV|PV|VP|VPU|HCP|TM|LR)\d*$")
GEN = re.compile(r"^(GEN|GS|GN|UR|UNR|SLR|SLRD|SR|SRD|LRD|PWD|LDS)\d*$")
AC = re.compile(r"^(H|HA|HB|A|AB|B|M|G|C|E|J|K|EA|EV)\d*$")
NON_AC = re.compile(r"^(S|D|SS|F|FC|DV|VS)\d*$")
NUMBERED = re.compile(r"^[A-Z]{1,4}\d{1,3}$")


def coach_class(code: str | None) -> str | None:
    """"AC" | "NON_AC" | "GEN" for a coach code, "OTHER" for a coach that is not inspected, None if unknown."""
    c = re.sub(r"[^A-Z0-9]", "", (code or "").upper())
    if not c:
        return None
    if OTHER.match(c):
        return "OTHER"
    if GEN.match(c):
        return "GEN"
    if AC.match(c):
        return "AC"
    if NON_AC.match(c):
        return "NON_AC"
    return None


def rake_class(code: str) -> str | None:
    """The class of a coach in a rake read from RailRadar: a numbered unknown code counts as NON_AC; utility
    coaches and unnumbered unknown codes are None (left out)."""
    cls = coach_class(code)
    if cls == "OTHER":
        return None
    if cls is None and NUMBERED.match(code):
        return "NON_AC"
    return cls
