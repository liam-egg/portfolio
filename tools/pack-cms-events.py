#!/usr/bin/env python3
"""
Packs the CMS HEP Tutorial ntuple (data.root: 469,384 real 2011 collisions at 7 TeV, triggered on
an isolated muon, HLT_IsoMu24) into the event samples cms-events.html displays.

    python tools/pack-cms-events.py [vr/data.root] [out = vr/cms-events/events.json] [--per-sample 1500]

Needs uproot (pip install uproot). The ntuple holds reconstructed physics objects only (muon,
electron, photon and jet four-vectors, missing E_T), not hits or calorimeter cells, so the viewer
draws objects: tracks are propagated from each muon's momentum, and the chambers it crosses are
worked out from the detector layout.

Three samples, each with the quantity it is plotted by. The histograms are filled from every event
in the file that passes; a seeded random draw of up to --per-sample of those events is kept to browse.
  dimuon   two leading muons of opposite charge                           m(μμ)
  w        exactly one muon, pT > 25 GeV, Iso/pT < 0.1, no electron        m_T(μ, MET)
  top      an isolated muon, pT > 25 GeV, ≥ 4 jets, ≥ 1 b-tag (TCHE > 1.74)   M3, the 3-jet mass
           (jets pass ID and pT > 30 GeV; M3 is the trijet with the largest vector-sum pT)

Every event is { i: entry, npv, met: [px, py], mu: [[px, py, pz, E, q, iso]], el: [[px, py, pz, E, q, iso]],
ph: [[px, py, pz, E, iso]], j: [[px, py, pz, E, btag]], v: the sample's quantity }, momenta in GeV.
"""
import itertools
import json
import os
import sys

import awkward as ak
import numpy as np
import uproot

args = sys.argv[1:]
per_sample = 1500
if '--per-sample' in args:
    k = args.index('--per-sample')
    per_sample = int(args[k + 1])
    del args[k:k + 2]
src = args[0] if args else 'vr/data.root'
out = args[1] if len(args) > 1 else 'vr/cms-events/events.json'

BTAG = 1.74         # TCHE medium working point, as the tutorial uses
JET_PT = 30
MU_PT = 25
REL_ISO = 0.1

a = uproot.open(src)['events'].arrays()
n_all = len(a)
pt = lambda px, py: np.sqrt(px ** 2 + py ** 2)

mu_pt = pt(a.Muon_Px, a.Muon_Py)
mu_rel = a.Muon_Iso / mu_pt
lead_pt = ak.fill_none(ak.firsts(mu_pt), 0).to_numpy()
lead_rel = ak.fill_none(ak.firsts(mu_rel), 99).to_numpy()
iso_mu = (lead_pt > MU_PT) & (lead_rel < REL_ISO)
jet_ok = a.Jet_ID & (pt(a.Jet_Px, a.Jet_Py) > JET_PT)


def mass(E, px, py, pz):
    return np.sqrt(np.maximum(E ** 2 - px ** 2 - py ** 2 - pz ** 2, 0))


# dimuon: m of the two leading muons, opposite charge
two = (a.NMuon >= 2).to_numpy()
m_mumu = np.zeros(n_all)
os_mask = np.zeros(n_all, bool)
idx = np.flatnonzero(two)
mu2 = a[two]
q = mu2.Muon_Charge[:, :2].to_numpy()
os_mask[idx] = q[:, 0] * q[:, 1] < 0
m_mumu[idx] = mass(*(ak.sum(mu2[f'Muon_{c}'][:, :2], axis=1).to_numpy() for c in ('E', 'Px', 'Py', 'Pz')))

# W: transverse mass of the single muon and MET
met_px, met_py = a.MET_px.to_numpy(), a.MET_py.to_numpy()
mpx = ak.fill_none(ak.firsts(a.Muon_Px), 0).to_numpy()
mpy = ak.fill_none(ak.firsts(a.Muon_Py), 0).to_numpy()
m_t = np.sqrt(np.maximum(2 * (lead_pt * np.hypot(met_px, met_py) - (mpx * met_px + mpy * met_py)), 0))
w_mask = (a.NMuon == 1).to_numpy() & (a.NElectron == 0).to_numpy() & iso_mu

# top: M3 over good jets
n_jet = ak.sum(jet_ok, axis=1).to_numpy()
n_b = ak.sum(jet_ok & (a.Jet_btag > BTAG), axis=1).to_numpy()
top_mask = iso_mu & (n_jet >= 4) & (n_b >= 1)
m3 = np.zeros(n_all)
for i in np.flatnonzero(top_mask):
    ok = jet_ok[i].to_numpy()
    J = np.stack([a.Jet_E[i].to_numpy(), a.Jet_Px[i].to_numpy(), a.Jet_Py[i].to_numpy(), a.Jet_Pz[i].to_numpy()], 1)[ok]
    best = max(itertools.combinations(range(len(J)), 3), key=lambda c: np.hypot(*J[list(c), 1:3].sum(0)))
    m3[i] = mass(*J[list(best)].sum(0))

SAMPLES = [
    dict(key='dimuon', title='Z → μμ', label='dimuon', quantity='m(μμ)', unit='GeV', mask=os_mask, value=m_mumu,
         lo=0, hi=150, bins=75,
         about='Two muons of opposite charge. Their invariant mass peaks at the Z boson, 91 GeV.'),
    dict(key='w', title='W → μν', label='single muon', quantity='m_T', unit='GeV', mask=w_mask, value=m_t,
         lo=0, hi=150, bins=50,
         about='One isolated muon and missing E_T from the neutrino. Their transverse mass has its edge at the W mass, 80 GeV.'),
    dict(key='top', title='tt̄ → μ + jets', label='top pair', quantity='M3', unit='GeV', mask=top_mask, value=m3,
         lo=0, hi=600, bins=30,
         about='An isolated muon, four or more jets and a b-tag. The three-jet mass M3 peaks near the top quark, 173 GeV.'),
]

r2 = lambda v: round(float(v), 2)
cols = lambda i, names: [list(map(r2, row)) for row in zip(*(a[n][i].to_numpy() for n in names))] if len(a[names[0]][i]) else []


def event(i, value):
    jets = [row for row, ok in zip(cols(i, ['Jet_Px', 'Jet_Py', 'Jet_Pz', 'Jet_E', 'Jet_btag']), a.Jet_ID[i].to_numpy()) if ok]
    return dict(
        i=int(i), npv=int(a.NPrimaryVertices[i]), met=[r2(met_px[i]), r2(met_py[i])],
        mu=cols(i, ['Muon_Px', 'Muon_Py', 'Muon_Pz', 'Muon_E', 'Muon_Charge', 'Muon_Iso']),
        el=cols(i, ['Electron_Px', 'Electron_Py', 'Electron_Pz', 'Electron_E', 'Electron_Charge', 'Electron_Iso']),
        ph=cols(i, ['Photon_Px', 'Photon_Py', 'Photon_Pz', 'Photon_E', 'Photon_Iso']),
        j=jets, v=r2(value),
    )


rng = np.random.default_rng(0x5EED)
samples = []
for s in SAMPLES:
    passing = np.flatnonzero(s['mask'])
    counts, _ = np.histogram(s['value'][passing], bins=s['bins'], range=(s['lo'], s['hi']))
    keep = np.sort(rng.choice(passing, min(per_sample, len(passing)), replace=False))
    samples.append(dict(
        key=s['key'], title=s['title'], label=s['label'], quantity=s['quantity'], unit=s['unit'], about=s['about'],
        passing=int(len(passing)), hist=dict(lo=s['lo'], hi=s['hi'], counts=counts.tolist()),
        events=[event(i, s['value'][i]) for i in keep],
    ))
    print(f"  {s['key']:7s} {len(passing):7d} pass, {len(keep)} kept")

os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    json.dump(dict(source='CMS HEP Tutorial ntuple, 2011 data, 7 TeV, HLT_IsoMu24', events=n_all, samples=samples),
              f, ensure_ascii=False, separators=(',', ':'))
print(f'Wrote {out}: {n_all} events read, {os.path.getsize(out) / 1024:.0f} KB')
