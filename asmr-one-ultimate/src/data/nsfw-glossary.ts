/**
 * NSFW/ASMR Translation Glossary
 *
 * Curated from h2k frequency corpus (~45K terms from doujin voice works).
 * Only includes terms where MT models (NLLB) commonly fail:
 *   - Onomatopoeia (MT has zero training data for these)
 *   - NSFW slang/colloquial (MT may censor or mistranslate)
 *   - Domain-specific double meanings (e.g. トラック = audio track, not truck)
 *   - Address terms with cultural context
 *
 * Generic words (私, 言う, 見る, etc.) are intentionally excluded —
 * NLLB translates them correctly and substituting would break sentence flow.
 *
 * Format: [ja, en, zh, mode]
 *   mode 'a' = always substitute (onomatopoeia, MT always wrong)
 *   mode 'p' = prefer (NSFW terms, substitute in short text, hint in longer)
 *   mode 'e' = exact match only (phrases, address terms)
 *   mode 'c' = context-dependent (audio player domain meanings)
 */

export type GlossaryMode = 'a' | 'p' | 'e' | 'c';
export type GlossaryEntry = readonly [ja: string, en: string, zh: string, mode: GlossaryMode];

const GLOSSARY_DATA: readonly GlossaryEntry[] = [
    // ========================================================================
    // ONOMATOPOEIA — highest priority, MT always fails on these
    // ========================================================================
    ['しこしこ', '*stroking*', '*撸动*', 'a'],
    ['シコシコ', '*stroking*', '*撸动*', 'a'],
    ['れろれろ', '*licking*', '*舔弄*', 'a'],
    ['くちゅくちゅ', '*squelching*', '*咕啾咕啾*', 'a'],
    ['ぐちゅぐちゅ', '*squelching*', '*咕啾咕啾*', 'a'],
    ['どぴゅどぴゅ', '*spurting*', '*喷射*', 'a'],
    ['パンパン', '*slapping*', '*啪啪*', 'a'],
    ['ペロペロ', '*licking*', '*舔舔*', 'a'],
    ['ぺろぺろ', '*licking*', '*舔舔*', 'a'],
    ['とろとろ', 'melting', '融化', 'a'],
    ['トロトロ', 'melting', '融化', 'a'],
    ['ドロドロ', 'thick and sticky', '粘稠', 'a'],
    ['どろどろ', 'thick and sticky', '粘稠', 'a'],
    ['コリコリ', '*rubbing*', '*搓弄*', 'a'],
    ['こりこり', '*rubbing*', '*搓弄*', 'a'],
    ['ビンビン', 'rock hard', '硬邦邦', 'a'],
    ['ピクピク', '*twitching*', '*抽搐*', 'a'],
    ['ぴくぴく', '*twitching*', '*抽搐*', 'a'],
    ['ビクビク', '*trembling*', '*颤抖*', 'a'],
    ['もみもみ', '*kneading*', '*揉捏*', 'a'],
    ['ぐりぐり', '*grinding*', '*研磨*', 'a'],
    ['グリグリ', '*grinding*', '*研磨*', 'a'],
    ['こちょこちょ', '*tickle tickle*', '*咯吱咯吱*', 'a'],
    ['こしょこしょ', '*whispering*', '*窸窸窣窣*', 'a'],
    ['さわさわ', '*rustling*', '*沙沙*', 'a'],
    ['ちゅっちゅっ', '*kissing*', '*啾啾*', 'a'],
    ['くすくす', '*giggling*', '*嘻嘻*', 'a'],
    ['くすくすくす', '*giggling*', '*嘻嘻嘻*', 'a'],
    ['ほらほら', 'come on', '来嘛来嘛', 'a'],
    ['にゅるにゅる', '*slippery*', '*滑溜溜*', 'a'],
    ['ぴゅっぴゅっ', '*squirting*', '*噗嗤噗嗤*', 'a'],
    ['びゅるびゅる', '*gushing*', '*喷涌*', 'a'],
    ['びゅーっ', '*gushing*', '*喷射*', 'a'],
    ['ごしごし', '*scrubbing*', '*搓搓*', 'a'],
    ['ゴシゴシ', '*scrubbing*', '*搓搓*', 'a'],
    ['くんくん', '*sniffing*', '*嗅嗅*', 'a'],
    ['クンクン', '*sniffing*', '*嗅嗅*', 'a'],
    ['くりくり', '*twirling*', '*转弄*', 'a'],
    ['ドキドキ', '*heart pounding*', '*心跳加速*', 'a'],
    ['じゅるじゅる', '*slurping*', '*吸溜吸溜*', 'a'],
    ['じゅるじゅるじゅる', '*slurping*', '*吸溜吸溜吸溜*', 'a'],
    ['ちゅるっ', '*slurp*', '*吸溜*', 'a'],
    ['ちゅるちゅる', '*slurping*', '*吸溜吸溜*', 'a'],
    ['ちゅるん', '*slurp*', '*吸溜*', 'a'],
    ['ぴゅーっ', '*squirting*', '*喷射*', 'a'],
    ['ぬるぬる', 'slippery', '滑溜溜', 'a'],
    ['ヌルヌル', 'slippery', '滑溜溜', 'a'],
    ['ぐちょぐちょ', '*sopping wet*', '*湿哒哒*', 'a'],
    ['ぐちゃぐちゃ', '*messy*', '*乱糟糟*', 'a'],
    ['ねっとり', 'sticky', '黏腻', 'a'],
    ['ガチガチ', 'rock hard', '硬邦邦', 'a'],
    ['ギンギン', 'throbbing hard', '硬挺', 'a'],
    ['くちゅっ', '*squelch*', '*咕啾*', 'a'],
    ['ぐちゅっ', '*squelch*', '*咕啾*', 'a'],
    ['ちゅちゅ', '*sucking*', '*啾啾*', 'a'],
    ['ちゅーっ', '*sucking*', '*啾～*', 'a'],
    ['ちゅうっ', '*sucking*', '*啾～*', 'a'],
    ['ちゅうちゅう', '*sucking*', '*啾啾*', 'a'],
    ['ぴちゅっ', '*splat*', '*噗嗤*', 'a'],
    ['ぷるぷる', '*jiggling*', '*颤颤*', 'a'],
    ['ぷにぷに', '*squishy*', '*软乎乎*', 'a'],
    ['ふにふに', '*squishy*', '*软乎乎*', 'a'],
    ['じゅぶじゅぶ', '*squelching*', '*咕啾咕啾*', 'a'],
    ['じゅぽっ', '*pop*', '*啵*', 'a'],
    ['じゅぼじゅぼ', '*squelching*', '*咕啾咕啾*', 'a'],
    ['じゅぷじゅぷ', '*squelching*', '*咕啾咕啾*', 'a'],
    ['ずりずり', '*rubbing*', '*蹭蹭*', 'a'],
    ['ぞくぞく', '*shivers*', '*发麻*', 'a'],
    ['ゾクゾク', '*shivers*', '*发麻*', 'a'],
    ['ぎゅーっ', '*squeezing*', '*紧抱*', 'a'],
    ['ぎゅっと', '*squeezing tight*', '*紧紧地*', 'a'],
    ['ヌルヌル', 'slippery', '滑溜溜', 'a'],
    ['すべすべ', 'smooth', '光滑', 'a'],
    ['ネバネバ', 'sticky', '黏糊糊', 'a'],
    ['くくくっ', '*chuckling*', '*呵呵呵*', 'a'],
    ['ぷっくり', 'plump', '饱满', 'a'],
    ['じわじわ', 'gradually', '渐渐', 'a'],
    ['ガクガク', '*trembling*', '*发抖*', 'a'],
    ['つんつん', '*poking*', '*戳戳*', 'a'],
    ['ぐにぐに', '*squidgy*', '*软绵绵*', 'a'],
    ['ムラムラ', 'turned on', '欲火焚身', 'a'],
    ['ベトベト', 'sticky', '黏乎乎', 'a'],
    ['ぶちまける', 'splatter', '泼洒', 'a'],
    ['ヒクヒク', '*twitching*', '*抽搐*', 'a'],
    ['ひくひく', '*twitching*', '*抽搐*', 'a'],
    ['ずぼずぼ', '*thrusting*', '*抽插*', 'a'],
    ['ドクドク', '*pulsing*', '*脉动*', 'a'],
    ['ちろちろ', '*flicking*', '*轻舔*', 'a'],
    ['スリスリ', '*nuzzling*', '*蹭蹭*', 'a'],
    ['ハァハァ', '*panting*', '*喘息*', 'a'],
    ['ゆらゆら', '*swaying*', '*摇摇晃晃*', 'a'],
    ['くらくら', 'dizzy', '晕乎乎', 'a'],
    ['メロメロ', 'head over heels', '神魂颠倒', 'a'],
    ['ぽかぽか', 'warm', '暖洋洋', 'a'],
    ['カチカチ', 'rock hard', '硬邦邦', 'a'],
    ['かりかり', '*scratching*', '*刮擦*', 'a'],
    ['カリカリ', '*scratching*', '*刮擦*', 'a'],
    ['ぶるぶる', '*shivering*', '*发抖*', 'a'],
    ['じんじん', '*tingling*', '*麻麻的*', 'a'],
    ['じんわり', '*slowly spreading*', '*渐渐蔓延*', 'a'],
    ['ぴちゃぴちゃ', '*splashing*', '*啪嗒啪嗒*', 'a'],
    ['べろべろ', '*slobbering*', '*舔来舔去*', 'a'],
    ['ムズムズ', '*itching*', '*痒痒的*', 'a'],
    ['ビリビリ', '*tingling*', '*麻酥酥*', 'a'],
    ['ちこちこ', '*tickling*', '*搔弄*', 'a'],
    ['くるくる', '*spinning*', '*转转*', 'a'],
    ['ふわふわ', 'fluffy', '软绵绵', 'a'],
    ['すんすん', '*sniffling*', '*吸吸*', 'a'],
    ['ぐるぐる', '*swirling*', '*转圈*', 'a'],
    ['ごっくん', '*gulping*', '*咕噜*', 'a'],
    ['ピンク色', 'pink', '粉红色', 'a'],
    ['うっとり', 'entranced', '陶醉', 'a'],
    ['すーはー', '*breathing deeply*', '*深呼吸*', 'a'],
    ['ぼんやり', 'dazed', '恍惚', 'a'],
    ['とーっても', 'reaaally', '超级', 'a'],
    ['すっごい', 'amazing', '好厉害', 'a'],
    ['いーっぱい', 'so much', '好多好多', 'a'],
    ['ちゃーんと', 'properly', '好好地', 'a'],
    ['おっきい', 'big', '好大', 'a'],
    ['ちっちゃい', 'tiny', '好小', 'a'],
    ['たーっぷり', 'plenty', '满满地', 'a'],
    ['ゆーっくり', 'nice and slow', '慢慢地', 'a'],
    ['おっきな', 'big', '大大的', 'a'],
    ['大っきい', 'huge', '好大', 'a'],
    ['たっくさん', 'lots and lots', '好多好多', 'a'],
    ['ほぐれる', 'loosening up', '放松下来', 'a'],
    ['ぴったり', 'snug', '紧贴', 'a'],
    ['こぼれる', 'overflowing', '溢出', 'a'],
    ['ピストン', 'thrusting', '抽插', 'c'],
    ['あらあら', 'my my', '哎呀呀', 'a'],
    ['よいしょ', 'heave-ho', '嘿咻', 'a'],
    ['ちょうだい', 'give me', '给我', 'a'],

    // ========================================================================
    // NSFW BODY PARTS
    // ========================================================================
    ['おちんちん', 'cock', '鸡巴', 'p'],
    ['おっぱい', 'breasts', '奶子', 'p'],
    ['オッパイ', 'breasts', '奶子', 'p'],
    ['乳首', 'nipples', '乳头', 'p'],
    ['オマンコ', 'pussy', '小穴', 'p'],
    ['おまんこ', 'pussy', '小穴', 'p'],
    ['亀頭', 'glans', '龟头', 'p'],
    ['包茎', 'phimosis', '包茎', 'p'],
    ['前立腺', 'prostate', '前列腺', 'p'],
    ['尿道', 'urethra', '尿道', 'p'],
    ['膣', 'vagina', '阴道', 'p'],
    ['クリトリス', 'clitoris', '阴蒂', 'p'],
    ['クリちゃん', 'clit', '小豆豆', 'p'],
    ['カリ首', 'corona', '冠状沟', 'p'],
    ['金玉', 'balls', '睾丸', 'p'],
    ['睾丸', 'testicles', '睾丸', 'p'],
    ['子宮', 'womb', '子宫', 'p'],
    ['陰茎', 'penis', '阴茎', 'p'],
    ['肛門', 'anus', '肛门', 'p'],
    ['性器', 'genitals', '性器', 'p'],
    ['男性器', 'male genitalia', '男性器', 'p'],
    ['女性器', 'female genitalia', '女性器', 'p'],
    ['乳房', 'breasts', '乳房', 'p'],
    ['乳', 'breasts', '奶子', 'p'],
    ['母乳', 'breast milk', '母乳', 'p'],
    ['ちんちん', 'cock', '鸡巴', 'p'],
    ['チンチン', 'cock', '鸡巴', 'p'],
    ['タマタマ', 'balls', '蛋蛋', 'p'],
    ['玉', 'balls', '蛋蛋', 'c'],
    ['竿', 'shaft', '茎身', 'p'],
    ['棒', 'rod', '棒子', 'c'],
    ['穴', 'hole', '穴', 'c'],
    ['尻', 'butt', '屁股', 'p'],
    ['太もも', 'thighs', '大腿', 'p'],
    ['股', 'crotch', '胯部', 'p'],
    ['股間', 'crotch', '胯间', 'p'],
    ['腋', 'armpit', '腋下', 'p'],
    ['脇', 'armpit', '腋下', 'p'],
    ['谷間', 'cleavage', '乳沟', 'p'],
    ['割れ目', 'slit', '裂缝', 'p'],
    ['下半身', 'lower body', '下半身', 'p'],
    ['舌先', 'tip of the tongue', '舌尖', 'p'],
    ['付け根', 'base', '根部', 'p'],
    ['根元', 'base', '根部', 'p'],
    ['先端', 'tip', '前端', 'p'],
    ['魔羅', 'cock', '肉棒', 'p'],
    ['粘膜', 'mucous membrane', '粘膜', 'p'],
    ['性感帯', 'erogenous zone', '性感带', 'p'],

    // ========================================================================
    // NSFW FLUIDS
    // ========================================================================
    ['精液', 'cum', '精液', 'p'],
    ['ザーメン', 'cum', '精液', 'p'],
    ['スペルマ', 'cum', '精液', 'p'],
    ['精子', 'sperm', '精子', 'p'],
    ['カウパー', 'pre-cum', '前列腺液', 'p'],
    ['子種', 'seed', '子种', 'p'],
    ['唾液', 'saliva', '唾液', 'p'],
    ['涎', 'drool', '口水', 'p'],
    ['唾', 'spit', '唾液', 'p'],
    ['汁', 'juices', '汁液', 'c'],
    ['御汁', 'juices', '淫汁', 'p'],
    ['液', 'fluid', '液体', 'c'],
    ['液体', 'fluid', '液体', 'p'],
    ['蜜', 'nectar', '蜜液', 'c'],
    ['潮', 'squirt', '潮', 'p'],
    ['体液', 'bodily fluids', '体液', 'p'],
    ['粘液', 'mucus', '粘液', 'p'],
    ['愛液', 'love juices', '爱液', 'p'],

    // ========================================================================
    // NSFW ACTS & STATES
    // ========================================================================
    ['射精', 'ejaculation', '射精', 'p'],
    ['オナニー', 'masturbation', '自慰', 'p'],
    ['セックス', 'sex', '性交', 'p'],
    ['勃起', 'erection', '勃起', 'p'],
    ['挿入', 'insertion', '插入', 'p'],
    ['パイズリ', 'titjob', '乳交', 'p'],
    ['フェラチオ', 'blowjob', '口交', 'p'],
    ['フェラ', 'blowjob', '口交', 'p'],
    ['手コキ', 'handjob', '手活', 'p'],
    ['足コキ', 'footjob', '足交', 'p'],
    ['中出し', 'creampie', '中出', 'a'],
    ['種付け', 'breeding', '播种', 'a'],
    ['妊娠', 'pregnancy', '怀孕', 'p'],
    ['孕む', 'get pregnant', '怀孕', 'p'],
    ['犯す', 'violate', '侵犯', 'p'],
    ['調教', 'training', '调教', 'a'],
    ['発情', 'in heat', '发情', 'a'],
    ['愛撫', 'caress', '爱抚', 'p'],
    ['搾り取る', 'milk dry', '榨取', 'p'],
    ['搾る', 'squeeze out', '榨取', 'p'],
    ['搾精', 'milking', '榨精', 'a'],
    ['寸止め', 'edging', '寸止', 'a'],
    ['焦らす', 'tease', '焦急', 'p'],
    ['揉む', 'grope', '揉捏', 'p'],
    ['絶頂', 'climax', '绝顶', 'p'],
    ['逝く', 'cum', '去了', 'p'],
    ['果てる', 'climax', '到达极限', 'p'],
    ['扱く', 'jerk', '撸', 'p'],
    ['扱き', 'jerking', '撸动', 'p'],
    ['しゃぶる', 'suck', '吸吮', 'p'],
    ['おしゃぶり', 'sucking', '吸吮', 'p'],
    ['くわえる', 'take in mouth', '含住', 'p'],
    ['弄る', 'fondle', '玩弄', 'p'],
    ['弄ぶ', 'toy with', '玩弄', 'p'],
    ['弄う', 'fondle', '玩弄', 'p'],
    ['交尾', 'mating', '交配', 'a'],
    ['自慰', 'masturbation', '自慰', 'p'],
    ['センズリ', 'masturbation', '自慰', 'p'],
    ['近親相姦', 'incest', '近亲相奸', 'p'],
    ['騎乗位', 'cowgirl position', '骑乘位', 'p'],
    ['四つん這い', 'on all fours', '跪趴着', 'p'],
    ['仰向け', 'lying face up', '仰面躺着', 'p'],
    ['拘束', 'bondage', '束缚', 'a'],
    ['縛る', 'tie up', '捆绑', 'p'],
    ['痴漢', 'groper', '痴汉', 'p'],
    ['催眠', 'hypnosis', '催眠', 'a'],
    ['洗脳', 'brainwashing', '洗脑', 'a'],
    ['奉仕', 'service', '服侍', 'p'],
    ['責める', 'torment', '折磨', 'p'],
    ['責め', 'torment', '折磨', 'p'],
    ['苛める', 'bully', '欺负', 'p'],
    ['虐める', 'bully', '欺负', 'p'],
    ['いじめる', 'bully', '欺负', 'p'],
    ['いたぶる', 'torment', '折磨', 'p'],
    ['発射', 'release', '发射', 'p'],
    ['おしっこ', 'pee', '尿尿', 'p'],
    ['おもらし', 'wetting', '漏尿', 'p'],
    ['御漏らし', 'wetting', '漏尿', 'p'],
    ['漏らす', 'leak', '漏出', 'p'],
    ['脱ぐ', 'undress', '脱衣', 'p'],
    ['脱がす', 'strip', '脱掉', 'p'],
    ['裸', 'naked', '裸体', 'p'],
    ['全裸', 'completely naked', '全裸', 'p'],
    ['丸出し', 'fully exposed', '全部露出', 'p'],
    ['丸見え', 'fully visible', '一览无余', 'p'],
    ['晒す', 'expose', '暴露', 'p'],
    ['出し入れ', 'in and out', '抽插', 'p'],
    ['突っ込む', 'thrust in', '插入', 'p'],
    ['突き上げる', 'thrust up', '顶弄', 'p'],
    ['突き出す', 'push out', '突出', 'p'],
    ['押し付ける', 'press against', '压上去', 'p'],
    ['押し込む', 'push in', '塞进去', 'p'],
    ['注ぐ', 'pour in', '注入', 'p'],
    ['注ぎ込む', 'pour into', '灌入', 'p'],
    ['流し込む', 'pour in', '灌入', 'p'],
    ['飲み込む', 'swallow', '吞下', 'p'],
    ['吸い込む', 'suck in', '吸入', 'p'],
    ['吸い取る', 'suck out', '吸取', 'p'],
    ['吸い上げる', 'suck up', '吸上来', 'p'],
    ['吸い出す', 'suck out', '吸出', 'p'],
    ['噴き出す', 'spurt out', '喷涌而出', 'p'],
    ['垂れ流し', 'dripping', '滴滴答答', 'p'],
    ['垂らす', 'drip', '滴下', 'p'],
    ['垂れる', 'drip', '垂下', 'p'],
    ['溢れる', 'overflow', '溢出', 'p'],
    ['あふれる', 'overflow', '溢出', 'p'],
    ['染み込む', 'soak in', '浸透', 'p'],
    ['濡れる', 'get wet', '湿润', 'p'],
    ['濡らす', 'make wet', '弄湿', 'p'],
    ['汚す', 'dirty', '弄脏', 'p'],
    ['汚れる', 'get dirty', '弄脏', 'p'],
    ['塗る', 'smear', '涂抹', 'p'],
    ['抜く', 'pull out', '拔出', 'c'],
    ['抜ける', 'come out', '脱出', 'c'],
    ['引き抜く', 'pull out', '拔出', 'p'],
    ['擦る', 'rub', '摩擦', 'p'],
    ['擦れる', 'rub against', '磨蹭', 'p'],
    ['擦り付ける', 'rub against', '蹭上去', 'p'],
    ['舐める', 'lick', '舔', 'p'],
    ['吸う', 'suck', '吸', 'p'],
    ['噛む', 'bite', '咬', 'p'],
    ['締め付ける', 'tighten', '夹紧', 'p'],
    ['締まる', 'tighten', '收紧', 'p'],
    ['締め', 'tightening', '收紧', 'c'],
    ['絡める', 'entwine', '缠绕', 'p'],
    ['絡む', 'get tangled', '纠缠', 'p'],
    ['絡みつく', 'cling to', '缠绕', 'p'],
    ['撫でる', 'stroke', '抚摸', 'p'],
    ['撫で撫で', 'pat pat', '摸摸', 'p'],
    ['触る', 'touch', '摸', 'p'],
    ['触れる', 'touch', '触碰', 'p'],
    ['挟む', 'squeeze between', '夹住', 'p'],
    ['挟み込む', 'squeeze between', '夹住', 'p'],
    ['掴む', 'grab', '抓住', 'p'],
    ['握る', 'grip', '握住', 'p'],
    ['広げる', 'spread', '张开', 'p'],
    ['開く', 'open', '打开', 'c'],
    ['剥く', 'peel back', '翻开', 'p'],
    ['剥ける', 'peel back', '翻开', 'p'],
    ['摘む', 'pinch', '捏', 'p'],
    ['動かす', 'move', '活动', 'p'],
    ['叩く', 'slap', '拍打', 'p'],
    ['踏む', 'step on', '踩', 'p'],
    ['踏みつける', 'stomp on', '踩踏', 'p'],
    ['蹴る', 'kick', '踢', 'p'],
    ['揺れる', 'sway', '摇晃', 'p'],
    ['揺らす', 'shake', '摇动', 'p'],
    ['膨らむ', 'swell', '膨胀', 'p'],
    ['膨れる', 'swell up', '鼓胀', 'p'],
    ['脈打つ', 'throb', '脉动', 'p'],
    ['痺れる', 'go numb', '发麻', 'p'],
    ['痙攣', 'convulse', '痉挛', 'p'],
    ['悶える', 'writhe', '扭动身体', 'p'],
    ['疼く', 'throb', '疼痛', 'p'],
    ['蒸れる', 'get steamy', '闷热', 'p'],
    ['火照る', 'feel hot', '发烫', 'p'],
    ['溶ける', 'melt', '融化', 'p'],
    ['溶かす', 'melt', '融化', 'p'],
    ['蕩ける', 'melt away', '融化', 'p'],
    ['堕ちる', 'fall', '堕落', 'p'],
    ['溺れる', 'drown in', '沉溺', 'p'],
    ['狂う', 'go crazy', '发疯', 'p'],
    ['壊れる', 'break', '坏掉', 'p'],
    ['壊す', 'break', '弄坏', 'p'],
    ['乱れる', 'get disheveled', '凌乱', 'p'],
    ['喘ぐ', 'pant', '喘息', 'p'],
    ['啜る', 'slurp', '啜饮', 'p'],
    ['誘惑', 'temptation', '诱惑', 'p'],
    ['誘う', 'seduce', '引诱', 'p'],
    ['誘導', 'guide', '引导', 'p'],
    ['見せる', 'show', '给看', 'c'],
    ['見せつける', 'show off', '炫耀', 'p'],
    ['囁く', 'whisper', '低语', 'p'],
    ['囁き', 'whisper', '耳语', 'p'],
    ['甘える', 'act spoiled', '撒娇', 'p'],
    ['甘やかす', 'spoil', '宠爱', 'p'],
    ['褒める', 'praise', '夸奖', 'p'],
    ['罵倒', 'verbal abuse', '辱骂', 'p'],
    ['罵る', 'curse at', '骂', 'p'],
    ['お仕置き', 'punishment', '惩罚', 'p'],
    ['罰', 'punishment', '惩罚', 'p'],
    ['躾', 'discipline', '管教', 'p'],
    ['拷問', 'torture', '拷问', 'p'],
    ['支配', 'domination', '支配', 'p'],
    ['屈服', 'submit', '屈服', 'p'],
    ['従う', 'obey', '服从', 'p'],
    ['命令', 'command', '命令', 'p'],
    ['抵抗', 'resistance', '抵抗', 'p'],
    ['強制', 'forced', '强制', 'p'],
    ['無理やり', 'by force', '强行', 'p'],
    ['無理矢理', 'by force', '强行', 'p'],
    ['暗示', 'suggestion', '暗示', 'p'],
    ['開発', 'develop', '开发', 'c'],
    ['解放', 'release', '释放', 'p'],
    ['禁止', 'forbidden', '禁止', 'p'],
    ['許可', 'permission', '许可', 'p'],
    ['お預け', 'denial', '不准', 'p'],
    ['我慢', 'endure', '忍耐', 'e'],
    ['抑える', 'hold back', '抑制', 'p'],

    // ========================================================================
    // NSFW DESCRIPTORS
    // ========================================================================
    ['変態', 'pervert', '变态', 'p'],
    ['淫乱', 'lewd', '淫荡', 'p'],
    ['淫ら', 'obscene', '淫秽', 'p'],
    ['淫語', 'dirty talk', '淫语', 'p'],
    ['いやらしい', 'naughty', '淫荡', 'p'],
    ['卑猥', 'obscene', '猥亵', 'p'],
    ['エッチ', 'lewd', '色色', 'p'],
    ['えっち', 'lewd', '色色', 'p'],
    ['童貞', 'virgin (male)', '童贞', 'p'],
    ['処女', 'virgin (female)', '处女', 'p'],
    ['快感', 'pleasure', '快感', 'p'],
    ['快楽', 'pleasure', '快乐', 'p'],
    ['性欲', 'lust', '性欲', 'p'],
    ['欲望', 'desire', '欲望', 'p'],
    ['欲情', 'arousal', '情欲', 'p'],
    ['欲求', 'urge', '欲求', 'p'],
    ['興奮', 'aroused', '兴奋', 'p'],
    ['敏感', 'sensitive', '敏感', 'p'],
    ['感度', 'sensitivity', '敏感度', 'p'],
    ['下品', 'vulgar', '下流', 'p'],
    ['臭い', 'smelly', '臭', 'c'],
    ['匂い', 'scent', '味道', 'p'],
    ['匂う', 'smell', '闻', 'p'],
    ['生臭い', 'fishy smell', '腥臭', 'p'],
    ['早漏', 'premature', '早泄', 'p'],
    ['短小', 'small', '短小', 'p'],
    ['無様', 'pathetic', '丑态', 'p'],
    ['情けない', 'pathetic', '没出息', 'p'],
    ['惨め', 'miserable', '悲惨', 'p'],
    ['はしたない', 'shameless', '不知廉耻', 'p'],
    ['みっともない', 'disgraceful', '不像话', 'p'],
    ['性癖', 'fetish', '性癖', 'p'],
    ['性的', 'sexual', '性的', 'p'],
    ['濃い', 'thick', '浓厚', 'c'],
    ['濃厚', 'rich/thick', '浓厚', 'p'],
    ['激しい', 'intense', '激烈', 'p'],
    ['激しく', 'intensely', '激烈地', 'p'],
    ['強烈', 'intense', '强烈', 'p'],

    // ========================================================================
    // ADDRESS & RELATIONSHIP TERMS
    // ========================================================================
    ['ご主人様', 'Master', '主人', 'e'],
    ['御主人様', 'Master', '主人', 'e'],
    ['お兄ちゃん', 'big brother', '哥哥', 'e'],
    ['お姉ちゃん', 'big sister', '姐姐', 'e'],
    ['お姉さん', 'big sister', '姐姐', 'e'],
    ['お姉さま', 'big sister', '姐姐大人', 'e'],
    ['お姉様', 'big sister', '姐姐大人', 'e'],
    ['おねえさん', 'big sister', '姐姐', 'e'],
    ['先輩', 'senpai', '前辈', 'e'],
    ['後輩', 'junior', '后辈', 'e'],
    ['先生', 'teacher', '老师', 'e'],
    ['坊や', 'little boy', '小家伙', 'e'],
    ['兄さん', 'brother', '哥哥', 'e'],
    ['姉さん', 'sister', '姐姐', 'e'],
    ['兄ちゃん', 'bro', '哥', 'e'],
    ['姉ちゃん', 'sis', '姐', 'e'],
    ['兄貴', 'bro', '大哥', 'e'],
    ['おにいさん', 'big brother', '哥哥', 'e'],
    ['ねーさん', 'sis', '姐', 'e'],
    ['お母さん', 'mother', '妈妈', 'e'],
    ['お父さん', 'father', '爸爸', 'e'],
    ['旦那', 'husband/sir', '老公', 'e'],
    ['お客様', 'dear guest', '客人', 'e'],
    ['お嬢様', 'young lady', '小姐', 'e'],
    ['女王様', 'Queen', '女王大人', 'e'],
    ['おばさん', 'auntie', '阿姨', 'e'],
    ['おじさん', 'uncle', '大叔', 'e'],
    ['ボクちゃん', 'little guy', '小家伙', 'e'],
    ['ダーリン', 'darling', '亲爱的', 'e'],
    ['メイドさん', 'maid', '女仆', 'e'],
    ['マスター', 'Master', '主人', 'e'],
    ['ワンちゃん', 'puppy', '小狗狗', 'e'],
    ['奴隷', 'slave', '奴隶', 'p'],
    ['サキュバス', 'succubus', '魅魔', 'e'],
    ['肉便器', 'cum dump', '肉便器', 'p'],
    ['便器', 'toilet', '便器', 'c'],
    ['家畜', 'livestock', '畜生', 'p'],
    ['負け犬', 'loser', '丧家之犬', 'p'],
    ['豚', 'pig', '猪', 'c'],
    ['犬', 'dog', '狗', 'c'],
    ['甘えん坊', 'spoiled child', '撒娇鬼', 'e'],
    ['夢魔', 'dream demon', '梦魔', 'e'],

    // ========================================================================
    // ASMR/AUDIO CONTEXT TERMS
    // ========================================================================
    ['トラック', 'track', '曲目', 'p'],
    ['耳かき', 'ear cleaning', '掏耳朵', 'e'],
    ['耳舐め', 'ear licking', '舔耳', 'e'],
    ['耳ふぅ', 'ear blowing', '吹耳', 'e'],
    ['耳フー', 'ear blowing', '吹耳', 'e'],
    ['耳元', 'close to the ear', '耳边', 'p'],
    ['耳たぶ', 'earlobe', '耳垂', 'p'],
    ['耳垢', 'earwax', '耳垢', 'p'],
    ['生耳舐め', 'raw ear licking', '真实舔耳', 'e'],
    ['添い寝', 'sleeping together', '陪睡', 'e'],
    ['まったり', 'relaxed', '悠闲', 'e'],
    ['膝枕', 'lap pillow', '膝枕', 'e'],
    ['マッサージ', 'massage', '按摩', 'e'],
    ['リラックス', 'relax', '放松', 'e'],
    ['吐息', 'sigh', '叹息', 'p'],
    ['囁き', 'whisper', '耳语', 'p'],
    ['深呼吸', 'deep breath', '深呼吸', 'e'],
    ['音声', 'audio', '音声', 'c'],
    ['効果音', 'sound effect', '音效', 'c'],
    ['綿棒', 'cotton swab', '棉签', 'e'],
    ['ローション', 'lotion', '润滑液', 'p'],
    ['おもちゃ', 'toy', '玩具', 'c'],
    ['オモチャ', 'toy', '玩具', 'c'],
    ['バイブ', 'vibrator', '震动棒', 'p'],
    ['コンドーム', 'condom', '避孕套', 'p'],
    ['ショーツ', 'panties', '内裤', 'p'],
    ['パンティ', 'panties', '内裤', 'p'],
    ['パンスト', 'pantyhose', '连裤袜', 'p'],
    ['ストッキング', 'stockings', '丝袜', 'p'],
    ['スク水', 'school swimsuit', '学校泳衣', 'p'],
    ['下着', 'underwear', '内衣', 'p'],
    ['白衣', 'white coat', '白大褂', 'p'],
    ['制服', 'uniform', '制服', 'p'],
    ['靴下', 'socks', '袜子', 'p'],
    ['水着', 'swimsuit', '泳衣', 'p'],
    ['首輪', 'collar', '项圈', 'p'],
    ['貞操帯', 'chastity belt', '贞操带', 'p'],
    ['鞭', 'whip', '鞭子', 'p'],
    ['道具', 'tool', '道具', 'c'],
    ['媚薬', 'aphrodisiac', '春药', 'p'],
    ['薬', 'medicine', '药', 'c'],
    ['オナホール', 'onahole', '飞机杯', 'a'],
    ['オナホ', 'onahole', '飞机杯', 'a'],
    ['生オナホ', 'raw onahole', '生飞机杯', 'a'],
    ['スライム', 'slime', '史莱姆', 'e'],

    // ========================================================================
    // EMOTIONAL/STATE DESCRIPTORS (ASMR-relevant)
    // ========================================================================
    ['気持ちいい', 'feels good', '好舒服', 'e'],
    ['気持ちよい', 'feels good', '好舒服', 'e'],
    ['気持ち良い', 'feels good', '好舒服', 'e'],
    ['気持ちよく', 'pleasurably', '舒服地', 'e'],
    ['恥ずかしい', 'embarrassing', '好害羞', 'e'],
    ['たまらない', "can't stand it", '受不了', 'e'],
    ['我慢できない', "can't hold back", '忍不住', 'e'],
    ['限界', 'at the limit', '到极限了', 'e'],
    ['駄目', 'no good', '不行了', 'e'],
    ['無理', 'impossible', '不行', 'e'],
    ['大丈夫', "it's okay", '没关系', 'e'],
    ['大丈夫だよ', "it's okay", '没关系的', 'e'],
    ['大好きだよ', 'I love you', '最喜欢你了', 'e'],
    ['愛してる', 'I love you', '我爱你', 'e'],
    ['くすぐったい', 'ticklish', '好痒', 'e'],
    ['もどかしい', 'frustrating', '焦急', 'e'],
    ['物足りない', 'not enough', '不够', 'e'],
    ['心地よい', 'comfortable', '舒适', 'e'],
    ['切ない', 'bittersweet', '切切', 'e'],
    ['緊張', 'nervous', '紧张', 'e'],
    ['安心', 'relieved', '安心', 'e'],
    ['幸せ', 'happy', '幸福', 'e'],
    ['妄想', 'fantasy', '妄想', 'p'],

    // ========================================================================
    // VERBS WITH NSFW CONNOTATION IN CONTEXT
    // ========================================================================
    ['イく', 'cum', '去了', 'p'],
    ['いく', 'cum', '去了', 'c'],
    ['イッちゃう', 'gonna cum', '要去了', 'p'],
    ['出す', 'let out', '射出来', 'c'],
    ['出る', 'come out', '出来了', 'c'],
    ['入れる', 'put it in', '放进去', 'c'],
    ['感じる', 'feel it', '有感觉', 'c'],
    ['見える', 'can see', '看得到', 'c'],
    ['止まらない', "can't stop", '停不下来', 'e'],
    ['堪える', 'endure', '忍耐', 'p'],
    ['耐える', 'endure', '忍受', 'p'],
    ['暴れる', 'thrash around', '挣扎', 'p'],
    ['襲う', 'attack', '袭击', 'p'],
    ['貢ぐ', 'offer tribute', '进贡', 'p'],
    ['くすぐる', 'tickle', '挠痒', 'p'],
    ['匂う', 'smell', '闻', 'p'],
    ['嗅ぐ', 'sniff', '闻', 'p'],
    ['浮気', 'cheating', '出轨', 'p'],
    ['告白', 'confess', '告白', 'p'],

    // ========================================================================
    // MISC DOMAIN TERMS
    // ========================================================================
    ['行為', 'act', '行为', 'p'],
    ['本番', 'the real thing', '正戏', 'p'],
    ['初体験', 'first time', '初体验', 'e'],
    ['密着', 'close contact', '紧贴', 'p'],
    ['接近', 'approach', '接近', 'p'],
    ['刺激', 'stimulation', '刺激', 'p'],
    ['反応', 'reaction', '反应', 'p'],
    ['振動', 'vibration', '振动', 'p'],
    ['圧迫', 'pressure', '压迫', 'p'],
    ['感触', 'texture', '触感', 'p'],
    ['感覚', 'sensation', '感觉', 'p'],
    ['理性', 'reason/sanity', '理性', 'p'],
    ['意識', 'consciousness', '意识', 'p'],
    ['本能', 'instinct', '本能', 'p'],
    ['脱力', 'go limp', '脱力', 'p'],
    ['気絶', 'faint', '晕厥', 'p'],
    ['余韻', 'afterglow', '余韵', 'p'],
    ['遺伝子', 'genes', '基因', 'p'],
    ['フェロモン', 'pheromone', '费洛蒙', 'p'],
    ['ロリコン', 'lolicon', '萝莉控', 'p'],
    ['ディープキス', 'deep kiss', '深吻', 'p'],
    ['幼馴染', 'childhood friend', '青梅竹马', 'e'],
    ['触手', 'tentacle', '触手', 'p'],
    ['水音', 'water sounds', '水声', 'p'],
    ['再生時間', 'total runtime', '播放时长', 'e'],
    ['総再生時間', 'total runtime', '总播放时长', 'e'],
    ['低音', 'low voice', '低音', 'e'],
    ['みみとろ', 'ear-melting', '耳朵融化', 'e'],
    ['カウントダウン', 'countdown', '倒计时', 'e'],
    ['カウント', 'count', '计数', 'c'],
    ['視聴', 'listening', '视听', 'c'],
    ['作品', 'work', '作品', 'c'],

    // ========================================================================
    // COLLOQUIAL PHRASES (exact match for short subtitle lines)
    // ========================================================================
    ['思いっきり', 'with all your might', '尽情地', 'e'],
    ['思う存分', 'to your heart\'s content', '尽情', 'e'],
    ['遠慮ない', 'without restraint', '不客气', 'e'],
    ['めちゃくちゃ', 'totally', '乱七八糟', 'e'],
    ['もう少し', 'a little more', '再多一点', 'e'],
    ['もっともっと', 'more and more', '更多更多', 'e'],
    ['もっと強く', 'harder', '再用力', 'e'],
    ['いきなり', 'suddenly', '突然', 'e'],
    ['一気に', 'all at once', '一口气', 'e'],
    ['ずーっと', 'always', '一直', 'e'],
    ['ずっとずっと', 'forever and ever', '一直一直', 'e'],
    ['しょうがない', 'can\'t be helped', '没办法', 'e'],
    ['ごちそうさま', 'thanks for the meal', '多谢款待', 'e'],
    ['いつまでも', 'forever', '永远', 'e'],
    ['何回', 'how many times', '几次', 'e'],
    ['一滴', 'every last drop', '一滴', 'e'],
    ['たっぷり', 'plenty', '满满', 'e'],
    ['いっぱい', 'lots', '好多', 'e'],
    ['たくさん', 'a lot', '很多', 'e'],
    ['言いなり', 'obedient', '言听计从', 'e'],
    ['ありのまま', 'as you are', '原原本本', 'e'],
    ['好きな人', 'the person I like', '喜欢的人', 'e'],

    // ========================================================================
    // COMMON CONVERSATIONAL (frequently hallucinated by MT systems)
    // ========================================================================
    ['どうぞ', 'please/go ahead', '请', 'e'],
    ['こっち', 'over here', '这边', 'e'],
    ['そっち', 'over there', '那边', 'e'],
    ['こっちおいで', 'come here', '过来这边', 'e'],
    ['こっちにおいで', 'come over here', '到这边来', 'e'],
    ['おいで', 'come here', '过来', 'e'],
    ['はじめまして', 'nice to meet you', '初次见面', 'e'],
    ['よろしくね', 'nice to meet you', '请多关照', 'e'],
    ['よろしくお願いします', 'pleased to meet you', '请多多关照', 'e'],
    ['おはよう', 'good morning', '早上好', 'e'],
    ['おやすみ', 'good night', '晚安', 'e'],
    ['おやすみなさい', 'good night', '晚安', 'e'],
    ['お疲れ様', 'good work', '辛苦了', 'e'],
    ['ただいま', "I'm home", '我回来了', 'e'],
    ['おかえり', 'welcome back', '欢迎回来', 'e'],
    ['お邪魔します', 'excuse the intrusion', '打扰了', 'e'],
    ['いらっしゃい', 'welcome', '欢迎', 'e'],
    ['いらっしゃいませ', 'welcome', '欢迎光临', 'e'],
    ['ふふ', '*giggle*', '*嘻嘻*', 'a'],
    ['ふふふ', '*giggle*', '*嘻嘻嘻*', 'a'],
    ['ふふっ', '*giggle*', '*嘻*', 'a'],
    ['えへへ', '*hehe*', '*嘿嘿*', 'a'],
    ['うふふ', '*ufufu*', '*呵呵*', 'a'],
    ['あはは', '*ahaha*', '*啊哈哈*', 'a'],
    ['ふっ', '*hmph*', '*哼*', 'a'],
    ['ふぅ', '*sigh*', '*呼*', 'a'],
    ['はぁ', '*sigh*', '*哈*', 'a'],
    ['んー', 'hmm', '嗯', 'a'],
    ['んっ', '*nn*', '*嗯*', 'a'],
    ['あっ', '*ah*', '*啊*', 'a'],
    ['あぁ', '*aah*', '*啊*', 'a'],
    ['特別', 'special', '特别', 'e'],
    ['裏オプ', 'secret option', '隐藏选项', 'e'],
    ['優越感', 'sense of superiority', '优越感', 'e'],
    ['背徳', 'immoral', '背德', 'e'],

    // ========================================================================
    // DLSITE TITLE/TAG VOCABULARY — compound terms MT systems often hallucinate.
    // Mode 'a' for unambiguous terms safe to substitute in any length text.
    // ========================================================================

    // Genre/theme tags (very common in 【】brackets)
    ['常識改変', 'common sense alteration', '常识改变', 'a'],
    ['性処理', 'sexual service', '性处理', 'a'],
    ['逆レイプ', 'reverse rape', '逆强奸', 'a'],
    ['逆レ', 'reverse rape', '逆强奸', 'a'],
    ['寝取り', 'cuckolding', '牛头人', 'a'],
    ['寝取られ', 'being cuckolded', '被牛', 'a'],
    ['搾乳', 'breast milking', '榨乳', 'a'],
    ['潮吹き', 'squirting', '潮吹', 'a'],
    ['おねショタ', 'oneshota', '姐正太', 'a'],
    ['ショタ', 'shota', '正太', 'a'],
    ['ロリ', 'loli', '萝莉', 'a'],
    ['ふたなり', 'futanari', '扶她', 'a'],
    ['百合', 'yuri', '百合', 'a'],
    ['ボテ腹', 'pregnant belly', '孕肚', 'a'],
    ['ハーレム', 'harem', '后宫', 'a'],
    ['異種姦', 'interspecies', '异种奸', 'a'],
    ['獣姦', 'bestiality', '兽奸', 'a'],
    ['陵辱', 'violation', '凌辱', 'a'],
    ['凌辱', 'violation', '凌辱', 'a'],
    ['輪姦', 'gangbang', '轮奸', 'a'],
    ['和姦', 'consensual sex', '和奸', 'a'],
    ['痴女', 'aggressive woman', '痴女', 'a'],
    ['女体化', 'genderswap', '女体化', 'a'],
    ['男の娘', 'femboy', '伪娘', 'a'],
    ['人外', 'non-human', '人外', 'a'],
    ['触手姦', 'tentacle sex', '触手奸', 'a'],
    ['母乳プレイ', 'lactation play', '母乳play', 'a'],
    ['アナル', 'anal', '肛交', 'a'],
    ['色仕掛け', 'seduction', '色诱', 'a'],
    ['快楽堕ち', 'pleasure corruption', '快乐堕落', 'a'],
    ['インモラル', 'immoral', '不道德', 'a'],

    // Personality/character archetypes (katakana loanwords MT systems often garble)
    ['ダウナー', 'downer', '阴郁系', 'a'],
    ['ツンデレ', 'tsundere', '傲娇', 'a'],
    ['ヤンデレ', 'yandere', '病娇', 'a'],
    ['クーデレ', 'kuudere', '酷娇', 'a'],
    ['メスガキ', 'cheeky brat', '雌小鬼', 'a'],
    ['ドS', 'sadistic', '抖S', 'a'],
    ['ドM', 'masochistic', '抖M', 'a'],

    // Physical descriptors (common in title character descriptions)
    ['高身長', 'tall', '高个子', 'a'],
    ['巨乳', 'big breasts', '巨乳', 'a'],
    ['爆乳', 'huge breasts', '爆乳', 'a'],
    ['貧乳', 'flat chest', '贫乳', 'a'],
    ['巨尻', 'big butt', '巨臀', 'a'],
    ['美人', 'beautiful woman', '美人', 'a'],
    ['美少女', 'beautiful girl', '美少女', 'a'],
    ['美女', 'beauty', '美女', 'a'],
    ['男嫌い', 'man-hater', '厌男', 'a'],
    ['清楚', 'prim and proper', '清纯', 'a'],
    ['黒ギャル', 'dark-skinned gal', '黑辣妹', 'a'],
    ['ギャル', 'gal', '辣妹', 'a'],

    // Title structure words (frequently in DLsite compound titles)
    ['おまけ', 'bonus', '附赠', 'a'],
    ['特化', 'specialized', '特化', 'a'],
    ['義務', 'duty', '义务', 'a'],
    ['行商人', 'merchant', '行商人', 'a'],
    ['冒険者', 'adventurer', '冒险者', 'a'],
    ['勇者', 'hero', '勇者', 'a'],
    ['魔王', 'demon lord', '魔王', 'a'],
    ['女騎士', 'female knight', '女骑士', 'a'],
    ['姫', 'princess', '公主', 'c'],
    ['王女', 'princess', '公主', 'a'],
    ['聖女', 'saintess', '圣女', 'a'],
    ['侍女', 'handmaiden', '侍女', 'a'],
    ['女将', 'proprietress', '女将', 'a'],
    ['教師', 'teacher', '教师', 'a'],
    ['女教師', 'female teacher', '女教师', 'a'],
    ['看護師', 'nurse', '护士', 'a'],
    ['メイド', 'maid', '女仆', 'a'],
    ['受付嬢', 'receptionist', '前台小姐', 'a'],
    ['エルフ', 'elf', '精灵', 'a'],
    ['吸血鬼', 'vampire', '吸血鬼', 'a'],
    ['狐', 'fox', '狐', 'c'],
    ['人妻', 'married woman', '人妻', 'a'],
    ['未亡人', 'widow', '寡妇', 'a'],
    ['義母', 'stepmother', '继母', 'a'],
    ['義姉', 'stepsister', '义姐', 'a'],
    ['後輩女子', 'junior girl', '学妹', 'a'],
    ['同僚', 'colleague', '同事', 'a'],
    ['隣人', 'neighbor', '邻居', 'a'],

    // Audio/recording terms
    ['バイノーラル', 'binaural', '双耳', 'a'],
    ['ハイレゾ', 'hi-res', '高解析度', 'a'],
    ['全年齢', 'all ages', '全年龄', 'a'],
    ['おまけトラック', 'bonus track', '附赠曲目', 'e'],
    ['ボーナストラック', 'bonus track', '附赠曲目', 'e'],
    ['オホ声', 'ahegao voice', '痴声', 'a'],
    ['アヘ声', 'ahegao voice', '痴声', 'a'],
    ['アヘ顔', 'ahegao', '痴颜', 'a'],
    ['喘ぎ声', 'moaning voice', '喘息声', 'a'],
    ['吐息多め', 'lots of sighs', '叹息多', 'a'],
    ['主観', 'POV', '主观视角', 'a'],
    ['複数プレイ', 'group play', '多人play', 'a'],
    ['連続', 'continuous', '连续', 'a'],
    ['大量', 'large amount', '大量', 'a'],
    ['肉棒', 'cock', '肉棒', 'a'],
] as const;

// ========================================================================
// Runtime lookup structures (built once on import)
// ========================================================================

/** Map for O(1) exact lookup */
export const glossaryMap = new Map<string, { en: string; zh: string; mode: GlossaryMode }>();

/** Sorted by length desc for longest-match-first substring search */
const glossarySorted: { ja: string; en: string; zh: string; mode: GlossaryMode }[] = [];

for (const [ja, en, zh, mode] of GLOSSARY_DATA) {
    glossaryMap.set(ja, { en, zh, mode });
    glossarySorted.push({ ja, en, zh, mode });
}

glossarySorted.sort((a, b) => b.ja.length - a.ja.length);

/** Only 'a' (always) entries, for substring replacement in sentences */
const alwaysEntries = glossarySorted.filter(e => e.mode === 'a');

/** 'a' + 'p' entries, for short text replacement */
const preferEntries = glossarySorted.filter(e => e.mode === 'a' || e.mode === 'p');

// ========================================================================
// Compiled regex for fast substring replacement (single-pass O(n) per text)
// Built once on import. Alternation is ordered longest-first (from sort above)
// so the regex engine matches greedily on the longest glossary term.
// ========================================================================

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReplacerRegex(entries: typeof glossarySorted): RegExp {
    return new RegExp(entries.map(e => escapeRegex(e.ja)).join('|'), 'g');
}

function buildReplacerMap(entries: typeof glossarySorted): { en: Map<string, string>; zh: Map<string, string> } {
    const en = new Map<string, string>();
    const zh = new Map<string, string>();
    for (const e of entries) {
        en.set(e.ja, e.en);
        zh.set(e.ja, e.zh);
    }
    return { en, zh };
}

export const alwaysRegex = buildReplacerRegex(alwaysEntries);
export const alwaysReplacerMap = buildReplacerMap(alwaysEntries);

export const preferRegex = buildReplacerRegex(preferEntries);
export const preferReplacerMap = buildReplacerMap(preferEntries);

// ========================================================================
// Whisper ASR Hallucination Corrections
//
// Whisper's language model was trained on "clean" data and systematically
// replaces NSFW terms with acoustically similar safe words. These are
// text-level post-processing corrections: wrong transcription → correct JP.
//
// Unlike the translation glossary above (correct JP → EN/ZH), this fixes
// the Japanese text itself before it reaches translation or display.
//
// Format: [hallucinated, correct]
//   - Ordered longest-first automatically (like the glossary)
//   - Applied as substring replacement within segments
//
// To add new entries: listen for recurring Whisper mistakes in your audio
// and add the [wrong, correct] pair here.
// ========================================================================

const WHISPER_CORRECTIONS: readonly [hallucinated: string, correct: string][] = [
    // Whisper hears safe kanji for explicit terms (same/similar reading)
    ['写生', '射精'],          // shasei (sketching) → shasei (ejaculation) — identical reading
    ['お寿司', 'おちんぽ'],    // osushi → ochinpo — acoustic substitution
    ['尋抱', 'ちんぽ'],        // xunbao-like CN hallucination heard in JP NSFW context
    ['同程', '童貞'],          // doucheng (CN company) → doutei (virgin) — kanji substitution
    ['同定', '童貞'],          // doutei (identification) → doutei (virgin) — same reading
    ['重生', '中性'],          // random CN hallucination in JP segments

    // Whisper inserts random English in Japanese segments (training data bleed)
    // These are full-word removals (the English word is pure noise, not code-switch)
    // Using regex patterns handled separately below
];

/** Compiled regex for single-pass substring replacement of hallucinated text */
const whisperCorrectionMap = new Map<string, string>();
const whisperCorrectionPatterns: string[] = [];

for (const [wrong, correct] of WHISPER_CORRECTIONS) {
    whisperCorrectionMap.set(wrong, correct);
    whisperCorrectionPatterns.push(escapeRegex(wrong));
}

// English words that Whisper hallucinates into Japanese-only segments.
// Matched as whole words (\b boundaries) to avoid false positives.
const ENGLISH_HALLUCINATION_WORDS = [
    'archipelago', 'subscribe', 'ambassador', 'algorithm',
];
const englishHallucinationRe = new RegExp(
    '\\b(' + ENGLISH_HALLUCINATION_WORDS.join('|') + ')\\b',
    'gi',
);

const whisperCorrectionRe = whisperCorrectionPatterns.length
    ? new RegExp(whisperCorrectionPatterns.join('|'), 'g')
    : null;

/**
 * Correct known Whisper ASR hallucinations in a Japanese text segment.
 * Returns the corrected text, or the original if no corrections apply.
 */
export function correctWhisperText(text: string): string {
    if (!text) return text;
    let result = text;

    // 1. Fix Japanese hallucinated words (kanji/kana substitutions)
    if (whisperCorrectionRe) {
        result = result.replace(whisperCorrectionRe, (match) =>
            whisperCorrectionMap.get(match) ?? match,
        );
    }

    // 2. Remove stray English hallucination words from Japanese segments
    // Only apply if the text is predominantly CJK (avoid stripping legit EN in mixed text)
    const cjkCount = (result.match(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/g) || []).length;
    const totalChars = result.replace(/\s/g, '').length;
    if (totalChars > 0 && cjkCount / totalChars > 0.5) {
        result = result.replace(englishHallucinationRe, '').replace(/\s{2,}/g, ' ').trim();
    }

    return result;
}
