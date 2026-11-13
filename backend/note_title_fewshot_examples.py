"""Frozen Codex-authored synthetic demonstrations; no evaluation notes or labels.

Selected before any candidate evaluation to illustrate general Russian title
style and source-grounded distinctions. These examples are not evidence about
the current user's note. This is in-context training, not a weight update.
"""

import hashlib
import json
from types import MappingProxyType


VERSION = "ordinary-ru-title-demonstrations-v1"
TRAINING_SHA256 = "e428fdcf304c719f418ecede839f3250efd4afd629ece3a2e114872ad49acd34"
LINEAGE = MappingProxyType(
    {
        "author": "Codex, a GPT-based coding agent",
        "authorship": "AI-authored synthetic source/title pairs and corrections",
        "created_date": "2026-10-12",
        "selection": "Independent ordinary topics; general style and logic only",
        "data_access": "No DEV/CLOSED notes, answers or reference titles read",
        "evaluation_tuning": False,
        "weight_training": False,
        "human_authorship_claim": False,
        "semantic_accuracy_claim": False,
    }
)

# Tuple records and string values keep the training payload immutable.
WRITER_EXAMPLES = (
    (
        "Переставил кресло к окну. Теперь можно читать при дневном свете, "
        "а старое место у двери свободно.",
        "Кресло переставлено к окну",
    ),
    (
        "Сегодня не стал поливать кактус: почва ещё влажная. Проверю её снова "
        "через несколько дней и только потом решу, нужен ли полив.",
        "Полив кактуса отложен из-за влажной почвы",
    ),
    (
        "Если дождь закончится до вечера, пойду гулять в парк. Если нет, "
        "проведу вечер дома. Пока прогноз не смотрел.",
        "Прогулка в парке, если дождь закончится до вечера",
    ),
    (
        "Почему один наушник звучит тише другого? Громкость телефона общая, "
        "а разница заметна в нескольких песнях. Причину пока не нашёл.",
        "Почему один наушник звучит тише другого?",
    ),
    (
        "Хочу научиться печь ржаной хлеб. Пока только ищу простой рецепт "
        "и собираюсь купить подходящую форму; первую попытку ещё не делал.",
        "Планы научиться печь ржаной хлеб",
    ),
    (
        "Вяжу шарф для себя. Половина уже готова, но второй конец и кисточки "
        "ещё предстоит сделать. Даты окончания не назначал.",
        "Шарф наполовину связан",
    ),
    (
        "Кажется, я оставил книгу в автобусе. Не уверен: мог положить её "
        "дома на другую полку. Сначала проверю квартиру.",
        "Книга, возможно, осталась в автобусе",
    ),
    (
        "Сравнил бумажную папку и альбом для семейных фотографий. Выбрал папку: "
        "туда легче добавлять новые снимки. Саму папку пока не купил.",
        "Для семейных фотографий выбрана папка, но ещё не куплена",
    ),
)

# Each record is (full source, untrusted draft, private audit, final title).
EDITOR_EXAMPLES = (
    (
        "На подоконнике стоят две белые чашки. Обе пустые.",
        "Две белый чашки на подоконнике",
        "Основной предмет сохранён. Прилагательное должно согласоваться "
        "с существительным во множественном числе.",
        "Две белые чашки на подоконнике",
    ),
    (
        "Когда откроется новая пекарня у дома? На двери есть вывеска, "
        "но даты открытия я не видел.",
        "Новая пекарня у дома уже открылась",
        "Исходник спрашивает о неизвестной дате; черновик ошибочно объявляет "
        "открытие состоявшимся. Сохраняю вопрос.",
        "Когда откроется новая пекарня у дома?",
    ),
    (
        "Собираюсь научиться делать глиняную миску, покрывать её глазурью "
        "и обжигать в мастерской. До записи на занятия дело ещё не дошло.",
        "План делать глиняную миску, покрывать её глазурью и потом обжигать её "
        "в мастерской",
        "Это намерение учиться, а не готовая миска. Сокращаю длинный черновик "
        "до связного заголовка, сохраняя существенную стадию.",
        "Планы научиться делать и обжигать глиняную миску",
    ),
    (
        "Варенье сварено, банки закрыты. Осталось подписать крышки.",
        "Варенье сварено банки закрыты",
        "Два однородных сообщения подтверждены исходником. Между частями "
        "нужна запятая; новые сведения не добавляю.",
        "Варенье сварено, банки закрыты",
    ),
)


def training_sha256():
    """Hash canonical training content, independent of Python source formatting."""
    payload = {
        "version": VERSION,
        "lineage": dict(LINEAGE),
        "writer_examples": WRITER_EXAMPLES,
        "editor_examples": EDITOR_EXAMPLES,
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8", errors="strict")
    return hashlib.sha256(canonical).hexdigest()
