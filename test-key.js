// 频道名称标准化 - 最终版
function getChannelKey(name) {
    if (!name) return '';
    var lower = name.toLowerCase();

    // 1. 去掉括号里的内容（如 (高清)、【高清】、(亚)）
    lower = lower.replace(/[()（）【】\[\]{}「」『』〔〕][^)）】\]{}」』〕]+[)）】\]{}」』〕]/g, '');

    // 2. 去掉尾部修饰词（高清/HD/标清/4K/版/频道 等）
    lower = lower.replace(/\s*(超高清|超清|蓝光|4k|8k|fhd|hd|标清|高清|版|频道|台)$/g, '');

    // 3. 提取 base 标识：允许字母和数字之间有 - 或空格
    // 如 cctv-1、cctv 1、cctv1、cctv-5+、sdtv-3
    var baseMatch = lower.match(/[a-z]+[-\s]?[0-9]+\+?/);
    if (baseMatch) {
        // 标准化：去掉 base 里的连字符和空格
        var base = baseMatch[0].replace(/[-\s]/g, '');

        // 提取中文描述部分
        var desc = lower.replace(/[a-z0-9\+\s\-_\.:：,，、()（）【】\[\]{}「」"「」]+/g, '');

        // 子频道关键词 → 独立 key（CCTV-4 欧洲 ≠ CCTV-4）
        var subChannelKeywords = [
            '欧洲', '美洲', '非洲', '亚太', '东南亚', '南亚', '中东',
            '阿拉伯', '西班牙', '法国', '俄国', '俄罗斯',
            '英语', '外语', '奥林匹克'
        ];
        var isSubChannel = subChannelKeywords.some(function (kw) {
            return desc.indexOf(kw) !== -1;
        });

        if (isSubChannel) {
            return base + '_' + desc;
        } else {
            // 主频道：直接返回 base，忽略"综合/体育/新闻频道"等描述
            return base;
        }
    }

    // 4. 没有字母数字前缀（"湖南卫视"、"珠江新闻眼"）→ 用中文 clean
    var cleaned = lower.replace(/[\s\-_\.:：,，、()（）【】\[\]{}「」"「」\+]+/g, '');
    cleaned = cleaned.replace(/(超高清|超清|蓝光|4k|8k|fhd|高清|标清|hd|版|频道|卫视|台)$/i, '');
    return cleaned;
}

// === 测试 ===
function runTest() {
    const cases = [
        // CCTV 主频道（必须合并）
        ['CCTV-1', 'CCTV-1 综合', 'CCTV1', 'CCTV 1 综合', 'cctv-1'],
        ['cctv-5', 'CCTV5 体育', 'CCTV-5 体育频道', 'cctv5体育'],
        ['CCTV-13', 'CCTV13新闻', 'CCTV 13 新闻频道'],
        ['CCTV-2', 'CCTV2 财经', 'CCTV-2 财经频道'],
        ['CCTV-3', 'CCTV3 综艺', 'CCTV-3 综艺频道'],
        ['CCTV-6', 'CCTV6 电影'],
        ['CCTV-7', 'CCTV7 国防军事', 'CCTV-7 国防军事频道'],
        ['CCTV-5+', 'CCTV5+ 体育赛事', 'CCTV-5+ 体育赛事频道'],
        // CCTV 中文国际（亚/港/澳 都合并到主频道，但欧/美 是独立子频道）
        ['CCTV-4 中文国际', 'CCTV-4 中文国际(亚)', 'CCTV-4 中文国际(港)'],
        // CCTV 子频道（必须独立）
        ['CCTV-4 欧洲', 'CCTV-4 美洲'],
        // 卫视（高清/HD 必须合并）
        ['湖南卫视', '湖南卫视 HD', '湖南卫视高清', '湖南卫视(高清)', '湖南卫视hd'],
        ['东方卫视', '东方卫视HD', '东方卫视高清', '东方卫视(高清)'],
        ['浙江卫视', '浙江卫视高清', '浙江卫视(高清)', '浙江卫视 HD'],
        ['北京卫视', '北京卫视HD', '北京卫视高清', '北京卫视(高清)'],
        ['广东体育', '广东体育频道', '广东体育高清', '广东体育hd'],
        // 地方台
        ['云南卫视', '云南高清', '云南卫视高清'],
        ['新闻综合'],
        ['珠江新闻', '珠江新闻眼'], // 这俩是独立频道
        ['哈哈炫动', '哈哈炫动卫视'],
    ];

    console.log('=== getChannelKey 最终版 ===\n');
    let totalOk = 0, totalFail = 0;
    for (const group of cases) {
        const keys = group.map(getChannelKey);
        const allSame = keys.every(k => k === keys[0]);
        if (allSame) {
            totalOk++;
            console.log(`✅ "${keys[0]}" ← ${group.join(' / ')}`);
        } else {
            totalFail++;
            console.log(`❌ 未合并:`);
            for (let i = 0; i < group.length; i++) {
                console.log(`   ${group[i]} → "${keys[i]}"`);
            }
        }
    }
    console.log(`\n结果: ${totalOk}/${totalOk + totalFail} 通过`);
}

runTest();
