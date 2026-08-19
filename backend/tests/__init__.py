"""Backend test suite. No network, no live database, no clock dependence.

The straddle engine is pure, so it is driven entirely with synthetic bars. The
resolver is pure SQL, so it is pointed at a throwaway database built in a temp
directory; the real backend/upstox.db is never opened.
"""
