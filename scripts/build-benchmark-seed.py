#!/usr/bin/env python3
# Generates seeds/benchmarks.csv from the compact tables below.
#
# The CSV is 216 rows and nobody should hand-edit it; this file is where a
# figure is corrected or a country added. Run from the repository root:
#
#     python3 scripts/build-benchmark-seed.py
#
#
# Values are approximate nominal GDP (US$ millions) and mid-year population
# (thousands) for 2021-2023, plus oil and non-oil value added for the GCC.
# They are transcribed, not downloaded — the whole point of the `verified`
# flag on the source. The directional shape is the real one: most economies
# fell in dollar terms in 2022 as the dollar strengthened and recovered in
# 2023, while the GCC peaked in 2022 on high oil prices and fell back in 2023.
SRC = 'indicative'

# iso3: (gdp 2021, 2022, 2023)  in US$ millions
GDP = {
    'USA': (23594000, 25744000, 27360000),
    'CHN': (17820000, 17880000, 17795000),
    'DEU': (4278000, 4085000, 4456000),
    'JPN': (5006000, 4256000, 4213000),
    'IND': (3150000, 3390000, 3550000),
    'GBR': (3141000, 3089000, 3340000),
    'FRA': (2966000, 2782000, 3031000),
    'ITA': (2114000, 2012000, 2255000),
    'BRA': (1649000, 1920000, 2174000),
    'CAN': (2007000, 2138000, 2140000),
    'RUS': (1836000, 2244000, 2021000),
    'MEX': (1313000, 1466000, 1789000),
    'AUS': (1553000, 1693000, 1724000),
    'KOR': (1818000, 1674000, 1713000),
    'ESP': (1445000, 1418000, 1581000),
    'IDN': (1187000, 1319000, 1371000),
    'NLD': (1029000, 1010000, 1118000),
    'TUR': (819000, 907000, 1108000),
    'SAU': (871000, 1109000, 1068000),
    'CHE': (813000, 819000, 885000),
    'POL': (681000, 688000, 811000),
    'BEL': (600000, 583000, 632000),
    'SWE': (635000, 591000, 593000),
    'ARG': (487000, 632000, 641000),
    'NOR': (490000, 579000, 486000),
    'ARE': (415000, 508000, 504000),
    'QAT': (180000, 237000, 213000),
    'KWT': (137000, 175000, 161000),
    'OMN': (88000, 115000, 108000),
    'BHR': (39000, 44000, 44000),
}

# iso3: (population 2021, 2022, 2023) in thousands
POP = {
    'USA': (332000, 333300, 335000),
    'CHN': (1412000, 1412000, 1410000),
    'DEU': (83200, 83800, 84500),
    'JPN': (125700, 125100, 124500),
    'IND': (1408000, 1418000, 1429000),
    'GBR': (67300, 67800, 68300),
    'FRA': (67800, 68000, 68200),
    'ITA': (59100, 59000, 58900),
    'BRA': (214000, 215300, 216000),
    'CAN': (38200, 38900, 40100),
    'RUS': (143400, 143600, 144000),
    'MEX': (126700, 127500, 128500),
    'AUS': (25700, 26000, 26600),
    'KOR': (51700, 51700, 51700),
    'ESP': (47400, 47800, 48400),
    'IDN': (273800, 275500, 277500),
    'NLD': (17530, 17700, 17900),
    'TUR': (84800, 85000, 85300),
    'SAU': (35950, 36400, 36900),
    'CHE': (8700, 8780, 8850),
    'POL': (37800, 36800, 36700),
    'BEL': (11590, 11660, 11740),
    'SWE': (10420, 10490, 10550),
    'ARG': (45800, 46200, 46650),
    'NOR': (5410, 5460, 5520),
    'ARE': (9370, 9440, 10500),
    'QAT': (2690, 2700, 2700),
    'KWT': (4250, 4270, 4300),
    'OMN': (4520, 4580, 4600),
    'BHR': (1460, 1480, 1500),
}

# GCC only. iso3: (oil GVA 2021, 2022, 2023) in US$ millions, at basic prices.
# 2022 is the oil-price peak; 2023 falls back on both price and OPEC+ cuts.
OIL = {
    'SAU': (240000, 380000, 300000),
    'ARE': (110000, 160000, 140000),
    'QAT': (65000, 100000, 78000),
    'KWT': (60000, 88000, 72000),
    'OMN': (28000, 42000, 34000),
    'BHR': (6000, 8500, 7000),
}
# Non-oil value added. Grows steadily — it is the diversification measure.
NONOIL = {
    'SAU': (570000, 655000, 700000),
    'ARE': (275000, 305000, 330000),
    'QAT': (103000, 116000, 122000),
    'KWT': (66000, 74000, 78000),
    'OMN': (54000, 60000, 63000),
    'BHR': (30000, 32500, 34000),
}

YEARS = ('2021', '2022', '2023')
rows = []
for iso3, values in GDP.items():
    for year, v in zip(YEARS, values):
        rows.append((SRC, iso3, 'gdp_current_usd', year, v, 'USD_MN'))
for iso3, values in POP.items():
    for year, v in zip(YEARS, values):
        rows.append((SRC, iso3, 'population', year, v, 'PERSONS_TH'))
for indicator, table in (('oil_gva_usd', OIL), ('non_oil_gva_usd', NONOIL)):
    for iso3, values in table.items():
        for year, v in zip(YEARS, values):
            rows.append((SRC, iso3, indicator, year, v, 'USD_MN'))

with open('seeds/benchmarks.csv', 'w') as f:
    f.write('source_code,country_iso3,indicator,period_label,value,unit_code\n')
    for r in rows:
        f.write(','.join(str(x) for x in r) + '\n')
print(f'{len(rows)} rows, {len(GDP)} countries, {len(YEARS)} years')

# Sanity: oil + non-oil should be within a plausible distance of GDP.
for iso3 in OIL:
    for i, year in enumerate(YEARS):
        gva = OIL[iso3][i] + NONOIL[iso3][i]
        gdp = GDP[iso3][i]
        ratio = gva / gdp
        assert 0.85 < ratio < 1.10, f'{iso3} {year}: GVA/GDP {ratio:.2f}'
print('oil + non-oil GVA sits plausibly below GDP at market prices for every GCC state')
