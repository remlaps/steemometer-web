# Changelog

## [0.0.3] - 2026-07-02
### Changed
- Improved continuous scrolling animation logic in VAAS display for smoother visual flow.
- Added empty state handling to VAAS container to hide it when no valid post or title is available.
- Updated digital dashboard scaling to use `BLOCKS_PER_MINUTE` instead of `SCALE_FACTOR` for max and avg calculations.
- Set minimum suggested vote percentage to 5% instead of 0%.
- Delayed the start of `vaasLoop` by 1000ms upon initialization.
- Adjusted CSS layouts: added dimensions to container, gauges, and graph; centralized vaas components.
