# Upper Deck ePack Trade COMC Price Check

A [Tampermonkey](https://www.tampermonkey.net/) userscript that integrates COMC pricing and trade partner data directly into the Upper Deck ePack trading interface.

**⚠️ In early development phase, use with caution and always remember to check COMC results yourself if in doubt.**

Built with Claude Sonnet 4.5

## Features

### Core Functionality
- **COMC Pricing for trades**: Fetch current market prices for physical cards directly from COMC
- **Trade Edit/Draft Mode Support**: Prices can be fetched even when building a counter trade or new draft — cards not yet in the API are resolved by extracting metadata directly from the DOM

### UI Enhancements
- **Card Value Info**: Display COMC prices directly on card tiles with clickable links
- **Physical Card Indicators**: Visual badges for physical cards with transferability status
- **Digital Card Fading**: Optional opacity styling for digital-only cards (configurable)
- **Trade Totals**: Automatic calculation of "You Get" and "You Give" totals
- **Quantity Display**: Show number of available cards on COMC (tooltip)
- **COMC Fee Toggle**: Toolbar toggle to include or exclude the $0.25 COMC sales fee from all displayed prices — preference is persisted per-browser and prices update instantly without re-fetching

![Card details](https://github.com/user-attachments/assets/f5f53f6a-3d9f-490d-9e59-64276752cc73)

### Trade Partner Information
- **Last Seen**: Relative time since their last login
- **Rating History**: Shows what rating they gave you in a closed trade (displays nothing if they didn't rate you)

![Trade information](https://github.com/user-attachments/assets/fe6582df-6454-4a79-bc34-1193b0f552cc)

## Usage

### Basic Workflow

1. **Navigate to a Trade**: Open any active or closed trade on ePack
2. **Fetch Prices**: Click the "Fetch COMC Prices" button
3. **Review Results**: Price info appears on each card with:
   - Current COMC price (clickable to view the COMC listing, or search page if no results are found)
   - Number of available cards on COMC
   - Digital/Physical/Non-transferable indicators
4. **Check Totals**: Review the calculated totals for each side
5. **Refresh**: Use "Refresh Prices" to clear cache and re-fetch

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Notes

- **Physical Cards Only**: Only physical cards have COMC prices (digital cards show "N/A")
- **COMC Accuracy**: Prices are fetched from COMC search results (lowest non-auction listing)
- **API Limits**: Respects rate limiting
- **COMC Fee**: The $0.25/card sales fee toggle defaults to included. Toggling it instantly recalculates all currently displayed prices without a new network request
- **Edit/Draft Mode**: When creating a counter trade or editing a draft, card data not yet in the ePack API is extracted from the DOM — accuracy may be lower for these cards

## Known Limitations

- Requires manual trigger (not automatic on page load)
- Only searches ungraded cards on COMC
- Relies on ePack's API structure (may break with updates)
- **Many sets will likely fail due to mismatches between Upper Deck and COMC set naming until rules are manually added to fix these cases**
