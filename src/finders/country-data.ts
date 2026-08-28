/**
 * Detection tables for src/finders/country.ts — every ISO-3166 country name
 * (lower-cased, with common aliases) and ~170 world cities that show up in
 * ATS location strings. The curated `COUNTRY_OPTIONS` list in country.ts is
 * for the preferences UI; detection must recognise *every* country so a
 * concrete foreign city is never mistaken for "unknown / anywhere".
 */

export const WORLD_COUNTRIES: Record<string, string> = {
  afghanistan: "AF", albania: "AL", algeria: "DZ", andorra: "AD", angola: "AO", argentina: "AR", armenia: "AM",
  australia: "AU", austria: "AT", azerbaijan: "AZ", bahamas: "BS", bahrain: "BH", bangladesh: "BD", barbados: "BB",
  belarus: "BY", belgium: "BE", belize: "BZ", benin: "BJ", bhutan: "BT", bolivia: "BO", "bosnia and herzegovina": "BA",
  bosnia: "BA", botswana: "BW", brazil: "BR", brasil: "BR", brunei: "BN", bulgaria: "BG", "burkina faso": "BF",
  burundi: "BI", cambodia: "KH", cameroon: "CM", canada: "CA", "cape verde": "CV", "cabo verde": "CV", chad: "TD",
  chile: "CL", china: "CN", colombia: "CO", congo: "CG", "costa rica": "CR", croatia: "HR", cuba: "CU", cyprus: "CY",
  "czech republic": "CZ", czechia: "CZ", denmark: "DK", djibouti: "DJ", "dominican republic": "DO", ecuador: "EC",
  egypt: "EG", "el salvador": "SV", estonia: "EE", ethiopia: "ET", fiji: "FJ", finland: "FI", france: "FR",
  georgia: "GE", germany: "DE", deutschland: "DE", ghana: "GH", greece: "GR", guatemala: "GT", guyana: "GY",
  haiti: "HT", honduras: "HN", "hong kong": "HK", hungary: "HU", iceland: "IS", india: "IN", indonesia: "ID",
  iran: "IR", iraq: "IQ", ireland: "IE", israel: "IL", italy: "IT", italia: "IT", "ivory coast": "CI",
  "côte d'ivoire": "CI", jamaica: "JM", japan: "JP", jordan: "JO", kazakhstan: "KZ", kenya: "KE", kosovo: "XK",
  kuwait: "KW", kyrgyzstan: "KG", laos: "LA", latvia: "LV", lebanon: "LB", libya: "LY", liechtenstein: "LI",
  lithuania: "LT", luxembourg: "LU", macedonia: "MK", "north macedonia": "MK", madagascar: "MG", malawi: "MW",
  malaysia: "MY", maldives: "MV", mali: "ML", malta: "MT", mauritius: "MU", mexico: "MX", méxico: "MX", moldova: "MD",
  monaco: "MC", mongolia: "MN", montenegro: "ME", morocco: "MA", mozambique: "MZ", myanmar: "MM", namibia: "NA",
  nepal: "NP", netherlands: "NL", "the netherlands": "NL", holland: "NL", "new zealand": "NZ", nicaragua: "NI",
  niger: "NE", nigeria: "NG", norway: "NO", oman: "OM", pakistan: "PK", panama: "PA", "papua new guinea": "PG",
  paraguay: "PY", peru: "PE", philippines: "PH", poland: "PL", polska: "PL", portugal: "PT", qatar: "QA",
  romania: "RO", russia: "RU", "russian federation": "RU", rwanda: "RW", "saudi arabia": "SA", senegal: "SN",
  serbia: "RS", singapore: "SG", slovakia: "SK", slovenia: "SI", somalia: "SO", "south africa": "ZA",
  "south korea": "KR", korea: "KR", "republic of korea": "KR", spain: "ES", españa: "ES", "sri lanka": "LK",
  sudan: "SD", sweden: "SE", switzerland: "CH", syria: "SY", taiwan: "TW", tajikistan: "TJ", tanzania: "TZ",
  thailand: "TH", togo: "TG", "trinidad and tobago": "TT", tunisia: "TN", turkey: "TR", türkiye: "TR",
  turkmenistan: "TM", uganda: "UG", ukraine: "UA", "united arab emirates": "AE", uae: "AE",
  "united kingdom": "GB", uk: "GB", "u.k.": "GB", "great britain": "GB", britain: "GB", england: "GB",
  scotland: "GB", wales: "GB", "northern ireland": "GB", "united states": "US", "united states of america": "US",
  usa: "US", "u.s.": "US", "u.s.a.": "US", "u.s": "US", "puerto rico": "US", uruguay: "UY", uzbekistan: "UZ",
  venezuela: "VE", vietnam: "VN", "viet nam": "VN", yemen: "YE", zambia: "ZM", zimbabwe: "ZW",
};

/** Lower-cased city (or city-ish token) → country. Only cities that are unambiguous world-wide. */
export const WORLD_CITIES: Record<string, string> = {
  // Europe
  paris: "FR", lyon: "FR", toulouse: "FR", nantes: "FR", berlin: "DE", munich: "DE", münchen: "DE", hamburg: "DE",
  frankfurt: "DE", cologne: "DE", köln: "DE", stuttgart: "DE", düsseldorf: "DE", amsterdam: "NL", rotterdam: "NL",
  utrecht: "NL", eindhoven: "NL", dublin: "IE", cork: "IE", galway: "IE", madrid: "ES", barcelona: "ES", valencia: "ES",
  malaga: "ES", málaga: "ES", lisbon: "PT", lisboa: "PT", porto: "PT", milan: "IT", milano: "IT", rome: "IT", roma: "IT",
  turin: "IT", torino: "IT", zurich: "CH", zürich: "CH", geneva: "CH", lausanne: "CH", basel: "CH", vienna: "AT",
  wien: "AT", graz: "AT", brussels: "BE", bruxelles: "BE", antwerp: "BE", ghent: "BE", stockholm: "SE", gothenburg: "SE",
  göteborg: "SE", malmö: "SE", oslo: "NO", bergen: "NO", copenhagen: "DK", københavn: "DK", aarhus: "DK",
  helsinki: "FI", tampere: "FI", warsaw: "PL", warszawa: "PL", krakow: "PL", kraków: "PL", wroclaw: "PL", wrocław: "PL",
  gdansk: "PL", gdańsk: "PL", poznan: "PL", poznań: "PL", prague: "CZ", praha: "CZ", brno: "CZ", budapest: "HU",
  bucharest: "RO", bucurești: "RO", "cluj-napoca": "RO", cluj: "RO", iasi: "RO", kyiv: "UA", kiev: "UA", lviv: "UA",
  athens: "GR", thessaloniki: "GR", sofia: "BG", belgrade: "RS", zagreb: "HR", ljubljana: "SI", bratislava: "SK",
  vilnius: "LT", kaunas: "LT", riga: "LV", tallinn: "EE", tirana: "AL", tiranë: "AL", nicosia: "CY", limassol: "CY",
  larnaca: "CY", valletta: "MT", luxembourg: "LU", reykjavik: "IS", minsk: "BY", chisinau: "MD", skopje: "MK",
  sarajevo: "BA", podgorica: "ME", pristina: "XK", edinburgh: "GB", glasgow: "GB", manchester: "GB", birmingham: "GB",
  leeds: "GB", bristol: "GB", cambridge: "GB", oxford: "GB", belfast: "GB", cardiff: "GB", reading: "GB",
  // Middle East & Africa
  istanbul: "TR", ankara: "TR", izmir: "TR", "tel aviv": "IL", jerusalem: "IL", haifa: "IL", dubai: "AE",
  "abu dhabi": "AE", riyadh: "SA", jeddah: "SA", doha: "QA", "kuwait city": "KW", manama: "BH", muscat: "OM",
  amman: "JO", beirut: "LB", cairo: "EG", casablanca: "MA", rabat: "MA", tunis: "TN", algiers: "DZ", lagos: "NG",
  abuja: "NG", nairobi: "KE", accra: "GH", addis: "ET", "cape town": "ZA", johannesburg: "ZA", pretoria: "ZA",
  durban: "ZA", kampala: "UG", kigali: "RW", "dar es salaam": "TZ",
  // Asia-Pacific
  bangalore: "IN", bengaluru: "IN", hyderabad: "IN", pune: "IN", mumbai: "IN", delhi: "IN", "new delhi": "IN",
  gurgaon: "IN", gurugram: "IN", noida: "IN", chennai: "IN", kolkata: "IN", ahmedabad: "IN", jaipur: "IN",
  chandigarh: "IN", kochi: "IN", karachi: "PK", lahore: "PK", islamabad: "PK", dhaka: "BD", colombo: "LK",
  kathmandu: "NP", singapore: "SG", "kuala lumpur": "MY", penang: "MY", "johor bahru": "MY", manila: "PH",
  makati: "PH", cebu: "PH", taguig: "PH", "ho chi minh": "VN", saigon: "VN", hanoi: "VN", "da nang": "VN",
  jakarta: "ID", bandung: "ID", bangkok: "TH", "chiang mai": "TH", tokyo: "JP", osaka: "JP", kyoto: "JP",
  fukuoka: "JP", seoul: "KR", busan: "KR", taipei: "TW", hsinchu: "TW", "hong kong": "HK", shanghai: "CN",
  beijing: "CN", shenzhen: "CN", guangzhou: "CN", hangzhou: "CN", chengdu: "CN", sydney: "AU", melbourne: "AU",
  brisbane: "AU", perth: "AU", adelaide: "AU", canberra: "AU", auckland: "NZ", wellington: "NZ", christchurch: "NZ",
  almaty: "KZ", tashkent: "UZ", tbilisi: "GE", yerevan: "AM", baku: "AZ", ulaanbaatar: "MN",
  // Latin America
  "mexico city": "MX", "ciudad de méxico": "MX", cdmx: "MX", guadalajara: "MX", monterrey: "MX", tijuana: "MX",
  "são paulo": "BR", "sao paulo": "BR", "rio de janeiro": "BR", "belo horizonte": "BR", curitiba: "BR",
  florianópolis: "BR", florianopolis: "BR", "porto alegre": "BR", recife: "BR", campinas: "BR", brasília: "BR",
  brasilia: "BR", "buenos aires": "AR", córdoba: "AR", cordoba: "AR", rosario: "AR", mendoza: "AR", bogotá: "CO",
  bogota: "CO", medellín: "CO", medellin: "CO", cali: "CO", barranquilla: "CO", santiago: "CL", valparaíso: "CL",
  lima: "PE", montevideo: "UY", quito: "EC", guayaquil: "EC", "la paz": "BO", asunción: "PY", asuncion: "PY",
  caracas: "VE", "guatemala city": "GT", "san salvador": "SV", tegucigalpa: "HN", managua: "NI", "panama city": "PA",
  "santo domingo": "DO", "san juan": "US", havana: "CU", kingston: "JM",
};

/** Words that mean "no fixed geography" — a posting made only of these is genuinely anywhere. */
export const REMOTEISH_RE = /\b(remote|anywhere|worldwide|world-wide|global|distributed|work from home|wfh|virtual|telecommute)\b/i;
