<?php
/**
 * Reading the Philippine address hierarchy.
 *
 * One table, one shape of query: "what is inside X". The picker walks down it a
 * step at a time, which is the only access pattern there is.
 *
 * Every function here degrades to empty rather than throwing when the table has
 * not been created or has not been filled. That is deliberate and it is what
 * lets the address question ship before the PSGC file is loaded: an empty list
 * makes the picker fall back to a text box, and the question still collects an
 * answer. A hard failure here would take the whole survey down over reference
 * data that is optional by design.
 *
 * ---------------------------------------------------------------------------
 * The picker starts at the PROVINCE, not at the top of the PSGC list.
 *
 * PSGC's top is the seventeen regions, and the picker used to open on them.
 * Nobody thinks of their address as starting at "Region X", and the region step
 * hid this college's own city: Cagayan de Oro is a Highly Urbanized City, which
 * PSGC files BESIDE Misamis Oriental under the region rather than inside it. A
 * student who opened Misamis Oriental read twenty-five municipalities and did
 * not find their city.
 *
 * So the first step is the provinces, and each Highly Urbanized City is offered
 * inside the province it sits in on the map (PH_ADDRESS_HUC_PROVINCE). That is
 * also how the address is written - "Cagayan de Oro City, Misamis Oriental" -
 * and it is what the College asked the stored line to say. Administratively
 * the city is still independent; this is where it is, not who governs it.
 *
 * Below the province the steps still follow the data rather than a fixed
 * ladder: Manila has a district between the city and its barangays, and the
 * BARMM Special Geographic Area has barangays with no municipality above them.
 * The picker asks what is inside whatever was chosen last and stops when
 * nothing is.
 * ---------------------------------------------------------------------------
 */

if (!defined('PH_ADDRESS_LIB')) {
    define('PH_ADDRESS_LIB', true);

    /** What each level is called on its own. */
    define('PH_ADDRESS_LEVEL_LABELS', [
        'region'          => 'Region',
        'province'        => 'Province',
        'city'            => 'City',
        'municipality'    => 'Municipality',
        'submunicipality' => 'District',
        'district'        => 'District',
        'barangay'        => 'Barangay',
    ]);

    /**
     * Levels that belong on one dropdown when they come back together.
     *
     * A province's children are cities AND municipalities, and a student should
     * pick from one list rather than being asked which kind of thing they live
     * in first. Where a mixed list comes back, the step is named for the group.
     *
     * Manila's fourteen sub-municipalities - Tondo I / II, Sampaloc, Ermita - are
     * what a Manila address calls its district, so that is the word used.
     */
    define('PH_ADDRESS_LEVEL_GROUPS', [
        'city'            => 'City / Municipality',
        'municipality'    => 'City / Municipality',
        'submunicipality' => 'District',
        'district'        => 'District',
    ]);

    /**
     * The province each Highly Urbanized City sits in on the map.
     *
     * PSGC parents these cities to their region, because they are governed
     * independently of any province. For picking and writing an address that is
     * the wrong way round: the city is inside the province on every map and on
     * every envelope. These are the PSA's own "geographically within" notes,
     * keyed by PSGC code, and they change only when a city is converted by law.
     *
     * A city missing from here is not lost. It stays under its region, and the
     * region is then offered at the province step (ph_address_provinces), so a
     * city added by a newer PSGC file is still reachable before this list is
     * updated. The 17 Metro Manila cities are deliberately absent: they are in
     * no province, and "Metro Manila" is what their addresses say.
     */
    define('PH_ADDRESS_HUC_PROVINCE', [
        '0330100000' => '0305400000', // Angeles         -> Pampanga
        '0331400000' => '0307100000', // Olongapo        -> Zambales
        '0431200000' => '0405600000', // Lucena          -> Quezon
        '0630200000' => '0604500000', // Bacolod         -> Negros Occidental
        '0631000000' => '0603000000', // Iloilo City     -> Iloilo
        '0730600000' => '0702200000', // Cebu City       -> Cebu
        '0731100000' => '0702200000', // Lapu-Lapu       -> Cebu
        '0731300000' => '0702200000', // Mandaue         -> Cebu
        '0831600000' => '0803700000', // Tacloban        -> Leyte
        '0931700000' => '0907300000', // Zamboanga City  -> Zamboanga del Sur
        '0990101000' => '1900700000', // Isabela City    -> Basilan
        '1030500000' => '1004300000', // Cagayan de Oro  -> Misamis Oriental
        '1030900000' => '1003500000', // Iligan          -> Lanao del Norte
        '1130700000' => '1102400000', // Davao City      -> Davao del Sur
        '1230800000' => '1206300000', // General Santos  -> South Cotabato
        '1430300000' => '1401100000', // Baguio          -> Benguet
        '1630400000' => '1600200000', // Butuan          -> Agusan del Norte
        '1731500000' => '1705300000', // Puerto Princesa -> Palawan
    ]);

    /**
     * What the province step calls a region that has places in no province.
     *
     * NCR has no provinces at all, and "Metro Manila" is the name its addresses
     * are written with. Any other region that ends up here (see
     * ph_address_provinces) is shown by its own name.
     */
    define('PH_ADDRESS_REGION_AS_PROVINCE', [
        '1300000000' => 'Metro Manila',
    ]);
}

/**
 * What to call a dropdown holding these levels.
 *
 * Sorted outermost-first before joining, because "City / Municipality /
 * Province" reads backwards - it names the smaller thing first and then the
 * bigger one, which is the opposite of how an address is written.
 */
function ph_address_label_for_levels(array $levels): string
{
    $levels = array_values(array_unique(array_filter($levels)));
    if (!$levels) {
        return 'Location';
    }

    $rank = array_flip(array_keys(PH_ADDRESS_LEVEL_LABELS));
    usort($levels, static fn(string $a, string $b): int => ($rank[$a] ?? 99) <=> ($rank[$b] ?? 99));

    $grouped = [];
    foreach ($levels as $level) {
        $name = PH_ADDRESS_LEVEL_GROUPS[$level] ?? (PH_ADDRESS_LEVEL_LABELS[$level] ?? ucfirst($level));
        if (!in_array($name, $grouped, true)) {
            $grouped[] = $name;
        }
    }

    return implode(' / ', $grouped);
}

/**
 * A city or municipality's name the way it is written in an address.
 *
 * PSGC files 138 cities as "City of X" - "City of Cagayan De Oro" - which is the
 * legal style and not what anyone writes. The College's own example reads
 * "Cagayan de Oro City", so "City of X" becomes "X City". The few cities whose
 * everyday name is built differently ("Island Garden City of Samal", "Science
 * City of Muñoz") do not start with "City of" and are left as they are.
 *
 * PSGC also capitalises the Spanish "de" and "del" inside a name. They are
 * lowercase in the names themselves - Cagayan de Oro, San Jose del Monte, Abra
 * de Ilog, Lope de Vega - so a De or Del between two words is lowered. Never the
 * first word: "Del Carmen" is a name that starts with Del.
 *
 * Barangay and province names are left exactly as PSGC spells them.
 */
function ph_address_display_name(string $name, string $level): string
{
    $name = trim($name);
    if ($level !== 'city' && $level !== 'municipality') {
        return $name;
    }

    if (preg_match('/^City of (.+)$/u', $name, $match)) {
        $name = $match[1] . ' City';
    }

    return (string)preg_replace_callback(
        '/(?<=\s)(De|Del)(?=\s)/u',
        static fn(array $m): string => strtolower($m[1]),
        $name
    );
}

/**
 * A place name reduced to what two spellings of it have in common.
 *
 * ZIP codes come from PHLPost's list, which names towns its own way: "Ozamis
 * City" for PSGC's "City of Ozamiz", "Sta. Ana" for "Santa Ana", "Bagong Nayon
 * (Cogeo)" for the barangay "Bagong Nayon". Lowercased, accents and the
 * bracketed part dropped, "City of X" and "X City" both made "x", the usual
 * abbreviations spelled out, and everything that is not a letter or a digit
 * removed. Spellings that still differ (Ozamis/Ozamiz) are matched by code in
 * tools/import_zip_codes.php, not by loosening this.
 *
 * Used by that importer and by ph_address_zip_codes() below, so a name is
 * compared the same way when the list is loaded and when it is read.
 */
function ph_address_zip_key(string $name): string
{
    $key = mb_strtolower(trim($name), 'UTF-8');
    $key = strtr($key, ['ñ' => 'n', 'á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u']);
    $key = (string)preg_replace('/\(.*?\)/u', '', $key);
    $key = (string)preg_replace('/^city of /u', '', trim($key));
    $key = (string)preg_replace('/ city$/u', '', trim($key));
    $key = (string)preg_replace(
        ['/\bsta\.?\s+/u', '/\bsto\.?\s+/u', '/\bgen\.?\s+/u', '/\bpres\.?\s+/u', '/\bgov\.?\s+/u'],
        ['santa ', 'santo ', 'general ', 'president ', 'governor '],
        $key
    );
    return (string)preg_replace('/[^a-z0-9]+/', '', $key);
}

/**
 * The ZIP codes for one chosen place, as the picker uses them.
 *
 *   [['zip' => '9000', 'area' => '']]            Cagayan de Oro: one, for all of it
 *   [['zip' => '4027', 'area' => ''],            Calamba: one for the city, and
 *    ['zip' => '4028', 'area' => 'Canlubang']]   one for a postal area inside it
 *   [['zip' => '1006', 'area' => 'Binondo'], ..] a Metro Manila city: areas only
 *
 * A barangay has no ZIP rows of its own. For one, the answer is the postal area
 * of its city (or Manila district) that bears the barangay's name, if exactly
 * one does: Calamba's barangay Canlubang gets 4028. Otherwise nothing, and the
 * picker keeps whatever the city gave.
 *
 * Empty, never an error, when ph_address_zip has not been created or loaded:
 * the ZIP box is then typed, as it was before this list existed.
 */
function ph_address_zip_codes(PDO $pdo, string $code): array
{
    static $ready = null;
    if ($ready === null) {
        try {
            $ready = api_table_exists($pdo, 'ph_address_zip');
        } catch (Throwable $e) {
            $ready = false;
        }
    }
    if (!$ready) {
        return [];
    }

    try {
        $rows = $pdo->prepare('SELECT zip_code, area FROM ph_address_zip WHERE psgc_code = :code ORDER BY area, zip_code');
        $read = static function (string $placeCode) use ($rows): array {
            $rows->execute([':code' => $placeCode]);
            return array_map(
                static fn(array $row): array => ['zip' => (string)$row['zip_code'], 'area' => (string)$row['area']],
                $rows->fetchAll(PDO::FETCH_ASSOC)
            );
        };

        $own = $read($code);
        if ($own) {
            return $own;
        }

        $place = $pdo->prepare('SELECT name, level, parent_code FROM ph_address WHERE psgc_code = :code');
        $place->execute([':code' => $code]);
        $barangay = $place->fetch(PDO::FETCH_ASSOC);
        if (!$barangay || $barangay['level'] !== 'barangay') {
            return [];
        }

        // Up to the district and then the city: the first with ZIPs decides.
        $key = ph_address_zip_key((string)$barangay['name']);
        $parent = (string)($barangay['parent_code'] ?? '');
        for ($depth = 0; $depth < 2 && $parent !== ''; $depth++) {
            $candidates = $read($parent);
            if ($candidates) {
                $named = array_values(array_filter(
                    $candidates,
                    static fn(array $zip): bool => $zip['area'] !== '' && ph_address_zip_key($zip['area']) === $key
                ));
                return count($named) === 1 ? $named : [];
            }
            $place->execute([':code' => $parent]);
            $parent = (string)($place->fetchColumn(2) ?: '');
        }
        return [];
    } catch (Throwable $e) {
        return [];
    }
}

function ph_address_table_ready(PDO $pdo): bool
{
    static $ready = null;
    if ($ready === null) {
        try {
            $ready = api_table_exists($pdo, 'ph_address');
        } catch (Throwable $e) {
            $ready = false;
        }
    }
    return $ready;
}

/** How many entries are loaded, so a caller can say "not filled in yet" rather than "empty". */
function ph_address_count(PDO $pdo): int
{
    if (!ph_address_table_ready($pdo)) {
        return 0;
    }
    try {
        return (int)$pdo->query('SELECT COUNT(*) FROM ph_address')->fetchColumn();
    } catch (Throwable $e) {
        return 0;
    }
}

/** One option as the picker receives it, with the name as it is written. */
function ph_address_option(array $row, ?string $asLevel = null): array
{
    $level = (string)$row['level'];
    return [
        'code' => (string)$row['psgc_code'],
        'name' => ph_address_display_name((string)$row['name'], $level),
        'level' => $asLevel ?? $level,
    ];
}

/**
 * Alphabetical by the name shown, with numbers in number order.
 *
 * Sorted here rather than in SQL because the name shown is not the name stored:
 * "City of Gingoog" is filed under C and read under G. Natural order puts
 * Manila's "Barangay 2" before "Barangay 10".
 */
function ph_address_sort(array $options): array
{
    usort($options, static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));
    return $options;
}

/** The active province codes, as a set. */
function ph_address_province_codes(PDO $pdo): array
{
    $codes = $pdo->query("SELECT psgc_code FROM ph_address WHERE is_active = 1 AND level = 'province'")
        ->fetchAll(PDO::FETCH_COLUMN);
    return array_fill_keys(array_map('strval', $codes), true);
}

/**
 * Whether a Highly Urbanized City is offered inside a province rather than
 * under its region. Only when that province is actually loaded - a mapping to a
 * province that is not there would leave the city reachable from nowhere.
 */
function ph_address_huc_placed(string $code, array $provinceCodes): bool
{
    $province = PH_ADDRESS_HUC_PROVINCE[$code] ?? null;
    return $province !== null && isset($provinceCodes[$province]);
}

/**
 * The first step: every province, plus Metro Manila.
 *
 * A region is offered here when it holds places no province does - once the
 * Highly Urbanized Cities have been placed in theirs, that is NCR (sixteen
 * cities and Pateros, "Metro Manila") and BARMM (the Special Geographic Area's
 * barangays, which this PSGC release files under no municipality). Worked out
 * from the data rather than listed, so a city a newer PSGC file adds is still
 * reachable before anyone updates PH_ADDRESS_HUC_PROVINCE.
 */
function ph_address_provinces(PDO $pdo): array
{
    if (!ph_address_table_ready($pdo)) {
        return [];
    }

    try {
        $options = [];
        foreach ($pdo->query("SELECT psgc_code, name, level FROM ph_address WHERE is_active = 1 AND level = 'province'") as $row) {
            $options[] = ph_address_option($row);
        }

        $provinceCodes = ph_address_province_codes($pdo);
        $regions = $pdo->query(
            "SELECT r.psgc_code AS region_code, r.name AS region_name, a.psgc_code
               FROM ph_address r
               JOIN ph_address a ON a.parent_code = r.psgc_code AND a.is_active = 1 AND a.level <> 'province'
              WHERE r.level = 'region' AND r.is_active = 1"
        )->fetchAll(PDO::FETCH_ASSOC);

        $withLeftovers = [];
        foreach ($regions as $row) {
            if (!ph_address_huc_placed((string)$row['psgc_code'], $provinceCodes)) {
                $withLeftovers[(string)$row['region_code']] = (string)$row['region_name'];
            }
        }
        foreach ($withLeftovers as $code => $name) {
            // Offered as a province, because at this step that is what it is
            // standing in for, and it is written where a province would be.
            $options[] = [
                'code' => (string)$code,
                'name' => PH_ADDRESS_REGION_AS_PROVINCE[$code] ?? $name,
                'level' => 'province',
            ];
        }

        return ph_address_sort($options);
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * The choices inside one chosen place.
 *
 *   a province -> its cities and municipalities, plus the Highly Urbanized
 *                 Cities that sit in it on the map
 *   a region   -> (only reachable as Metro Manila or BARMM) what is directly in
 *                 it and in no province
 *   anything else -> its children: a city's barangays, or Manila's districts
 *
 * The caller does not say what level it expects back. It cannot: whether a
 * city's children are barangays or districts depends on the city. The level
 * comes back WITH the options and the label follows from it.
 *
 * "All barangays" is 42,000 rows, so there is no call without a parent.
 */
function ph_address_places_in(PDO $pdo, string $code): array
{
    if (!ph_address_table_ready($pdo)) {
        return [];
    }

    try {
        $levelStmt = $pdo->prepare('SELECT level FROM ph_address WHERE psgc_code = :code AND is_active = 1');
        $levelStmt->execute([':code' => $code]);
        $level = $levelStmt->fetchColumn();
        if ($level === false) {
            return [];
        }

        $stmt = $pdo->prepare('SELECT psgc_code, name, level FROM ph_address WHERE is_active = 1 AND parent_code = :parent');
        $stmt->execute([':parent' => $code]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($level === 'region') {
            $provinceCodes = ph_address_province_codes($pdo);
            $rows = array_filter($rows, static fn(array $row): bool => $row['level'] !== 'province'
                && !ph_address_huc_placed((string)$row['psgc_code'], $provinceCodes));
        } elseif ($level === 'province') {
            $placed = array_keys(array_filter(PH_ADDRESS_HUC_PROVINCE, static fn(string $province): bool => $province === $code));
            if ($placed) {
                $in = implode(',', array_fill(0, count($placed), '?'));
                $hucs = $pdo->prepare("SELECT psgc_code, name, level FROM ph_address WHERE is_active = 1 AND psgc_code IN ($in)");
                $hucs->execute(array_map('strval', $placed));
                $rows = array_merge($rows, $hucs->fetchAll(PDO::FETCH_ASSOC));
            }
        }

        return ph_address_sort(array_map(static fn(array $row): array => ph_address_option($row), array_values($rows)));
    } catch (Throwable $e) {
        return [];
    }
}
