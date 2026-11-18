/**
 * Built-in intents: groups of words that mean the same thing, in English,
 * Hinglish, Hindi, Gujarati, Portuguese, Spanish, French, German and Italian. They serve twice:
 *   - the INTENT match type: a rule for "price" fires on "cost?", "rate kya hai", "कितना"
 *   - synonyms: an ANY_OF / ALL_OF / FUZZY keyword in a group also matches the rest of its group
 *
 * shortcut: a fixed list, not a trained model; extend a group here when the Activity log shows misses.
 */

export const INTENTS = Object.freeze({
    greeting: {
        label: 'Greeting',
        words: ['hi', 'hello', 'hey', 'hii', 'hiii', 'helo', 'hlo', 'namaste', 'namaskar', 'good morning', 'good afternoon',
            'good evening', 'kem cho', 'salaam', 'assalamualaikum', 'नमस्ते', 'नमस्कार', 'કેમ છો', 'નમસ્તે',
            // Portuguese, Spanish, French, German, Italian
            'ola', 'oi', 'bom dia', 'boa tarde', 'boa noite', 'hola', 'buenos dias', 'buenas tardes', 'bonjour', 'salut', 'bonsoir', 'hallo', 'guten tag', 'guten morgen', 'ciao', 'buongiorno', 'buonasera'],
    },
    price: {
        label: 'Price',
        words: ['price', 'prices', 'pricing', 'cost', 'costs', 'rate', 'rates', 'charges', 'charge', 'fee', 'fees', 'mrp',
            'how much', 'kitna', 'kitne', 'kitni', 'daam', 'dam', 'kimat', 'keemat', 'bhav', 'कीमत', 'दाम', 'कितना', 'कितने',
            'किंमत', 'ભાવ', 'કિંમત', 'કેટલા',
            // Portuguese, Spanish, French, German, Italian
            'preco', 'precos', 'quanto custa', 'quanto e', 'valor', 'precio', 'precios', 'cuanto cuesta', 'cuanto vale', 'prix', 'combien', 'tarif', 'preis', 'preise', 'was kostet', 'kosten', 'prezzo', 'prezzi', 'quanto costa'],
    },
    hours: {
        label: 'Opening hours',
        words: ['timing', 'timings', 'hours', 'open', 'opening', 'closing', 'closed', 'kab khulega', 'kab tak', 'kab band',
            'samay', 'समय', 'खुला', 'સમય',
            // Portuguese, Spanish, French, German, Italian
            'horario', 'horarios', 'que horas', 'aberto', 'abre', 'fecha', 'abierto', 'abren', 'cierran', 'heures', 'ouvert', 'ouverture', 'offnungszeiten', 'geoffnet', 'orari', 'orario', 'aperto'],
    },
    location: {
        label: 'Location',
        words: ['address', 'location', 'located', 'where', 'directions', 'map', 'branch', 'kahan', 'kaha', 'kidhar', 'pata',
            'पता', 'कहाँ', 'कहां', 'સરનામું', 'ક્યાં',
            // Portuguese, Spanish, French, German, Italian
            'endereco', 'onde fica', 'onde', 'localizacao', 'direccion', 'donde', 'ubicacion', 'adresse', 'ou etes vous', 'standort', 'indirizzo', 'dove'],
    },
    order_status: {
        label: 'Order status',
        words: ['order status', 'track', 'tracking', 'my order', 'where is my order', 'mera order', 'parcel', 'shipment',
            'dispatch', 'dispatched', 'ऑर्डर', 'ઓર્ડર',
            // Portuguese, Spanish, French, German, Italian
            'meu pedido', 'pedido', 'rastrear', 'rastreio', 'mi pedido', 'seguimiento', 'ma commande', 'commande', 'suivi', 'bestellung', 'meine bestellung', 'sendungsverfolgung', 'ordine', 'il mio ordine'],
    },
    delivery: {
        label: 'Delivery',
        words: ['delivery', 'deliver', 'shipping', 'courier', 'home delivery', 'dilivery', 'डिलीवरी', 'ડિલિવરી',
            // Portuguese, Spanish, French, German, Italian
            'entrega', 'frete', 'envio', 'livraison', 'expedition', 'lieferung', 'versand', 'consegna', 'spedizione'],
    },
    payment: {
        label: 'Payment',
        words: ['pay', 'payment', 'upi', 'gpay', 'google pay', 'phonepe', 'paytm', 'bank', 'card', 'qr', 'bhugtan',
            'भुगतान', 'પેમેન્ટ',
            // Portuguese, Spanish, French, German, Italian
            'pagamento', 'pagar', 'pix', 'pago', 'tarjeta', 'paiement', 'payer', 'zahlung', 'bezahlen', 'pagamento con carta'],
    },
    refund: {
        // Not "cancel": cancelling an order is its own rule (and plain CANCEL is an opt-out word).
        label: 'Refund / return',
        words: ['refund', 'return', 'replace', 'replacement', 'exchange', 'wapas', 'vapas',
            'वापस', 'रिफंड', 'પરત',
            // Portuguese, Spanish, French, German, Italian
            'reembolso', 'devolucao', 'devolver', 'troca', 'devolucion', 'remboursement', 'retour', 'erstattung', 'ruckgabe', 'rimborso', 'reso'],
    },
    catalog: {
        label: 'Products / catalogue',
        words: ['catalog', 'catalogue', 'products', 'product list', 'menu', 'items', 'stock', 'available', 'collection',
            'सामान', 'પ્રોડક્ટ',
            // Portuguese, Spanish, French, German, Italian
            'catalogo', 'produtos', 'productos', 'catalogue produits', 'produits', 'katalog', 'produkte', 'prodotti'],
    },
    complaint: {
        label: 'Complaint',
        words: ['complaint', 'complain', 'problem', 'issue', 'not working', 'broken', 'damaged', 'defective', 'kharab',
            'shikayat', 'शिकायत', 'खराब', 'ફરિયાદ',
            // Portuguese, Spanish, French, German, Italian
            'reclamacao', 'problema', 'reclamo', 'queja', 'plainte', 'probleme', 'beschwerde', 'reclamo servizio'],
    },
    thanks: {
        label: 'Thanks',
        words: ['thanks', 'thank you', 'thank u', 'thx', 'thanx', 'thnx', 'tq', 'tysm', 'ty', 'dhanyavad', 'shukriya', 'धन्यवाद', 'शुक्रिया', 'આભાર',
            // Portuguese, Spanish, French, German, Italian
            'obrigado', 'obrigada', 'gracias', 'merci', 'danke', 'grazie'],
    },
});

export const INTENT_IDS = Object.freeze(Object.keys(INTENTS));
