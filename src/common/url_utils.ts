import * as net from "../lib/net";

// To parse something like: (https://stackoverflow.com/questions/25942552/get-second-level-domain-name-from-url)
// https://images.google.com   => google
// https://www.google.com/blah => google
// https://www.google.co.uk/blah => google
// https://www.images.google.com/blah => google
const TLDs = new RegExp(/\.(com|net|org|biz|ltd|plc|edu|mil|asn|adm|adv|arq|art|bio|cng|cnt|ecn|eng|esp|etc|eti|fot|fst|g12|ind|inf|jor|lel|med|nom|ntr|odo|ppg|pro|psc|psi|rec|slg|tmp|tur|vet|zlg|asso|presse|k12|gov|muni|ernet|res|store|firm|arts|info|mobi|maori|iwi|travel|asia|web|tel)(\.[a-z]{2,3})?$|(\.[^\.]{2,3})(\.[^\.]{2,3})$|(\.[^\.]{2})$/);

function getDomainNameFromHostname(hostname) {
    if (net.isIP(hostname)) {
        return hostname;
    }
    return hostname.replace(TLDs, '').split('.').pop();
}

export const ChromePageTitle = "Chrome Page";
export const ChromeExtensionPageTitle = "Chrome Extension";

export function getDomainNameFromFullURL(url: string | URL) {
    // TODO: 处理 chrome:// schema
    // TODO: 处理 IP
    if (typeof url === "string") {
        if (url == "aadahadfdmiibmdhfmpbeeebejmjnkef") {
            console.log("hit")
        }
        if (url.startsWith("chrome://")) {
            return ChromePageTitle;
        } else if (url.startsWith("chrome-extension://")) {
            return ChromeExtensionPageTitle;
        }
        return getDomainNameFromHostname((new URL(url)).hostname);
    } else if (typeof url === "object" && url.hostname && url.protocol) {
        if (url.protocol.startsWith("chrome")) {
            return ChromePageTitle;
        } else if (url.protocol.startsWith("chrome-extension")) {
            return ChromeExtensionPageTitle;
        }
        return getDomainNameFromHostname(url.hostname);
    } else {
        console.log(`Unknown type ${typeof url} of ${JSON.stringify(url)}`);
        return "UNKNOWN_DATA_TYPE";
    }
}
