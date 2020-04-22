// To parse something like: (https://stackoverflow.com/questions/25942552/get-second-level-domain-name-from-url)
// https://images.google.com   => google
// https://www.google.com/blah => google
// https://www.google.co.uk/blah => google
// https://www.images.google.com/blah => google
export function getDomainName(hostname) {
    var TLDs = new RegExp(/\.(com|net|org|biz|ltd|plc|edu|mil|asn|adm|adv|arq|art|bio|cng|cnt|ecn|eng|esp|etc|eti|fot|fst|g12|ind|inf|jor|lel|med|nom|ntr|odo|ppg|pro|psc|psi|rec|slg|tmp|tur|vet|zlg|asso|presse|k12|gov|muni|ernet|res|store|firm|arts|info|mobi|maori|iwi|travel|asia|web|tel)(\.[a-z]{2,3})?$|(\.[^\.]{2,3})(\.[^\.]{2,3})$|(\.[^\.]{2})$/);
    return hostname.replace(TLDs, '').split('.').pop();
}

